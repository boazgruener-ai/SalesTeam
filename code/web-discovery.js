// Account discovery for onboarding (1.2.1, ONBOARDING_RESEARCH_DESIGN.md section 4 as revised 2026-09-30):
// THE WEB FIRST, LinkedIn optional (D11 as revised the same day).
//
// 1. The web: listing pages read with web fetch (discovery-filter.js decides what is kept), then a fit search when
//    they run short. Rows found this way become "Web" accounts; the pipeline looks each up on LinkedIn later.
// 2. LinkedIn, only when the user ticks it: the existing company Discovery (company-discovery-extraction.js), one
//    search per size band, in a small unfocused window, for LINKEDIN_SHARE of the target plus what the web fell
//    short of. LinkedIn's free company search does not hold its location filter (it leads with Microsoft, Google
//    even with Switzerland ticked) and needs the country name as a keyword, so it finds mostly companies with the
//    country in their name - local branches of international groups, which listings tend to miss. Merged the usual
//    way (autoMergeDiscoveryResults: a name-only match waits in the decision queue).
//
// Build step 3: started by hand from Advanced tools > "Find new accounts (new)", to MEASURE: web cost per listing,
// rows kept after filtering, and (optionally) LinkedIn pages per account found. From step 6 the wizard's
// Finish starts it. Progress and the result are kept under WEB_DISCOVERY_STATE_KEY (batch-status.js shows them).
import {
  getAnthropicApiKey, getCompanyContext, getIdealCustomerProfile, getOutputLanguage, getTargetUniverseConfig,
  getTargetContactProfile, getExclusionMatcher, getOrganizationTypeEligibility, getCompanyWebsite, getSellerCompanyName, getDiscoveryKnownAccounts,
  addWebDiscoveredCompanies, saveLastDiscoveryAdd, appendActivityLog, computeCompanyDeterministicPreScore, SIZE_PRIORITY_BUCKETS,
  getDiscoveredCompanies, getTargetAccountsWorkbook, autoMergeDiscoveryResults, normalizeCompanyName,
  getIncludedCompanies, addOnboardingMeasure,
} from "./storage.js";
import { matchesExclusion } from "./company-identity.js";
import { recordWebSpend } from "./pipeline-automation.js";
import { findDiscoveryListings, readDiscoveryListing, fitSearchDiscovery, sanitizeApiKey, apiBlockedReason } from "./agent-shared.js";
import {
  discoveryWanted, bandTargets, targetsLargest, buildKnownCompanies, cleanListingRow, filterListingRows, dropCounts,
  chooseDiscoveryRows,
} from "./discovery-filter.js";
import { WEB_DISCOVERY_STATE_KEY, discoveryText } from "./discovery-report.js";
import { rescoreDerivedPriorities } from "./auto-score.js";
import { startDiscoveryQueue, resetDiscoveryQueue } from "./discovery-queue.js";
import { runCompanyDiscoveryPhaseLocked } from "./company-discovery-extraction.js";
import { getRunningBatch, withBatch, BatchBusyError } from "./batch-jobs.js";
import { pausePipelineForUser } from "./pipeline-runner.js";
import { geoUrnForCountry } from "./geo-urn-map.js";

// Web rows collected before choosing: some over what is wanted, so "centre of the band first" has a choice.
const POOL_FACTOR = 1.5;
const MAX_LISTINGS_PER_COUNTRY = 5;
const MAX_ROWS_PER_LISTING = 100;
const RATE_LIMIT_WAIT_MS = 60000;
// The optional LinkedIn search's share of the target (local branches of international groups).
const LINKEDIN_SHARE = 0.2;
// How long to wait for the automatic LinkedIn work to finish its account and free LinkedIn.
const LINKEDIN_FREE_WAIT_MS = 4 * 60000;

let runner = null;

// `auto` (1.2.1 step 6): started by the wizard's Finish or by the stop rule (pipeline-runner.js) rather than from
// Advanced tools - its cost is recorded in the monthly web budget. `quiet`: no pop-up at the end (the stop rule's
// runs); the Activity Log line is written either way.
export async function startWebDiscovery({ target, budget, useLinkedin = false, auto = false, quiet = false, onDone = null }) {
  if (runner) throw new Error("Finding new accounts is already running.");
  const universe = await getTargetUniverseConfig();
  const countries = orderedCountries(universe);
  if (countries.length === 0) throw new Error("Pick your target countries first (Setup wizard > Location) - new accounts are looked for there.");
  const apiKey = sanitizeApiKey((await getAnthropicApiKey()) || "");
  if (!apiKey && !useLinkedin) throw new Error("Add your Anthropic API key first (Settings > Anthropic API Key) - the web search runs on your own key.");
  const t = Math.max(1, Math.round(Number(target) || 10));
  const state = {
    status: "running", target: t, wanted: discoveryWanted(t), countries, budget: Number(budget) || 0, spent: 0, hasKey: Boolean(apiKey),
    phase: "Starting", linkedin: null, webWanted: 0, calls: [], listings: [], rowsRead: 0, kept: 0, dropped: {}, fitRows: 0,
    added: 0, addedNames: [], skipped: 0, stoppedReason: null, lastError: null,
    startedAt: Date.now(), heartbeatAt: Date.now(), finishedAt: null, acknowledged: Boolean(quiet), auto: Boolean(auto), included: null,
  };
  const save = () => chrome.storage.local.set({ [WEB_DISCOVERY_STATE_KEY]: { ...state, heartbeatAt: Date.now() } }).catch(() => {});
  await save();
  const controller = new AbortController();
  runner = {
    stop(reason) {
      state.stoppedReason = state.stoppedReason || reason;
      controller.abort();
    },
  };
  run({ apiKey, universe, state, save, signal: controller.signal, useLinkedin, stop: (r) => runner?.stop(r) })
    .catch(() => {})
    .finally(() => { if (onDone) onDone(state); });
  return { ok: true, wanted: state.wanted, countries };
}

export function isWebDiscoveryRunning() {
  return Boolean(runner);
}

export function stopWebDiscovery() {
  if (runner) runner.stop("user");
  return { ok: !!runner };
}

// The target countries, highest location priority first.
function orderedCountries(universe) {
  const pr = universe.locationPriorities || {};
  return (universe.countries || []).filter(Boolean).map((c, i) => ({ c, i, p: Number(pr[c]) || 2 }))
    .sort((a, b) => b.p - a.p || a.i - b.i).map((x) => x.c);
}

function bandText(b) {
  const f = (n) => Number(n).toLocaleString("en-US");
  return Number.isFinite(b.max) ? `${b.label} (${f(b.min)}-${f(b.max)} employees)` : `${b.label} (${f(b.min)}+ employees)`;
}

async function run({ apiKey, universe, state, save, signal, useLinkedin, stop }) {
  const keepAlive = setInterval(() => { chrome.storage.local.get("keepAlive").catch(() => {}); save(); }, 10000);
  const stopped = () => signal.aborted;
  const addedKeys = [];
  const addedIds = [];
  try {
    const bands = SIZE_PRIORITY_BUCKETS;
    const linkedinCountries = state.countries.filter((c) => geoUrnForCountry(c));
    const withLinkedin = useLinkedin && linkedinCountries.length > 0;
    // D11 revised: the web finds the accounts; the optional LinkedIn search only adds local branches of
    // international groups (what listings rank under their group headquarters), a fixed share of the target.
    const linkedinShare = withLinkedin ? Math.max(1, Math.round(state.wanted * LINKEDIN_SHARE)) : 0;

    // ---- 0. The companies the user named on the wizard's "Companies you want included" (design 3.8) ----
    const inc = await includedPart({ state, save });
    addedKeys.push(...inc.keys);
    addedIds.push(...inc.companyIds);

    // ---- 1. The web ----
    state.webWanted = Math.max(0, state.wanted - linkedinShare - inc.keys.length);
    if (state.webWanted > 0) {
      if (!apiKey) {
        state.webSkipped = "no Anthropic API key (Settings > Anthropic API Key)";
      } else {
        const web = await webPart({ apiKey, universe, bands, state, save, signal, stop, countries: state.countries, wanted: state.webWanted });
        addedKeys.push(...web.keys);
        addedIds.push(...web.companyIds);
      }
    }
    if (stopped() && state.stoppedReason === "user") return;

    // ---- 2. LinkedIn (optional): its share, plus what the web fell short of ----
    if (withLinkedin && !stopped()) {
      const liWanted = Math.max(0, state.wanted - addedKeys.length);
      if (liWanted > 0) {
        const li = await linkedinPart({ universe, targets: bandTargets(universe.sizeBuckets, bands, liWanted), state, save, stopped });
        addedKeys.push(...li.keys);
        addedIds.push(...li.companyIds);
      }
    }
  } catch (err) {
    state.lastError = err.message;
    state.stoppedReason = state.stoppedReason || apiBlockedReason(err) || "errors";
  } finally {
    clearInterval(keepAlive);
    if (addedKeys.length) {
      await saveLastDiscoveryAdd({ at: state.startedAt, keys: addedKeys, companyIds: addedIds }).catch(() => {});
      await rescoreDerivedPriorities({ onlyCompanyIds: addedIds }).catch(() => null);
    }
    state.added = addedKeys.length;
    if (state.included && state.included.added > 0) state.addedNames = [...state.included.names, ...(state.addedNames || [])];
    if (state.webAdded > 0) await addOnboardingMeasure("discovery", { accounts: state.webAdded, usd: state.spent }).catch(() => {});
    if (state.auto && state.spent > 0) await recordWebSpend(state.spent).catch(() => {});
    state.status = "done";
    state.phase = null;
    state.finishedAt = Date.now();
    await save();
    runner = null;
    try {
      await appendActivityLog({ actor: "user", action: "web_discovery_finished", label: `Find new accounts: ${discoveryText(state)}` });
    } catch { /* the log entry is a convenience */ }
  }
}

// ---- Included companies ----

// Added first, whatever their size or industry; an exclusion still wins (the wizard flags a company on both lists).
// No web call: the pipeline and the web lane research them like any other "Web" account.
async function includedPart({ state, save }) {
  const list = await getIncludedCompanies();
  if (list.length === 0) return { keys: [], companyIds: [] };
  state.phase = "Adding the companies you want included";
  await save();
  const matcher = await getExclusionMatcher();
  const excluded = list.filter((c) => matchesExclusion(matcher, { name: c.name, website: c.website }));
  const rows = list.filter((c) => !excluded.includes(c)).map((c) => ({ name: c.name, website: c.website || null }));
  const res = rows.length ? await addWebDiscoveredCompanies(rows, { runAt: state.startedAt }) : { added: [], skipped: 0 };
  state.included = {
    asked: list.length, added: res.added.length, alreadyIn: res.skipped, excluded: excluded.map((c) => c.name),
    names: res.added.map((a) => a.company),
  };
  await save();
  return { keys: res.added.map((a) => a.key), companyIds: res.added.map((a) => a.companyId) };
}

// ---- LinkedIn part ----

// Waits until no other job holds LinkedIn, after asking the automatic pipeline to step aside (it finishes the
// account in progress). false when LinkedIn stayed busy.
async function waitForLinkedinFree(stopped) {
  await pausePipelineForUser("Find new accounts").catch(() => {});
  const until = Date.now() + LINKEDIN_FREE_WAIT_MS;
  while (!stopped() && Date.now() < until) {
    if (!(await getRunningBatch())) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return !stopped() && !(await getRunningBatch());
}

async function linkedinPart({ universe, targets, state, save, stopped }) {
  const li = { ran: false, bands: [], pages: 0, found: 0, added: 0, nameMatchesWaiting: 0, touchLimit: false, busy: false, excluded: {} };
  state.linkedin = li;
  state.phase = "Waiting for LinkedIn to be free";
  await save();
  if (!(await waitForLinkedinFree(stopped))) {
    li.busy = !stopped();
    return { keys: [], companyIds: [] };
  }
  const before = new Set(((await getTargetAccountsWorkbook()).companies || []).map((r) => r.companyId).filter(Boolean));
  const contactProfile = await getTargetContactProfile().catch(() => ({}));
  li.ran = true;
  try {
    // One lock for every band, so the automatic pipeline cannot take LinkedIn back between two searches.
    await withBatch("Find new accounts (LinkedIn)", async () => { for (const band of targets) {
      if (stopped() || li.touchLimit || band.count <= 0) continue;
      state.phase = `Searching LinkedIn - ${band.label} companies`;
      await save();
      // The existing Discovery caps on everything staged so far, so the cap is "what is staged + this band's share".
      const staged = (await getDiscoveredCompanies()).length;
      const sizeBuckets = { [band.key]: { checked: true, priority: band.priority } };
      await startDiscoveryQueue({ ...universe, ...contactProfile, sizeBuckets, maxCompanies: staged + band.count });
      const summary = await runCompanyDiscoveryPhaseLocked({
        shouldAbort: stopped,
        quiet: true,
        onProgress: ({ country, page }) => { state.phase = `Searching LinkedIn - ${band.label} companies, ${country}, page ${page}`; save(); },
      });
      const found = (await getDiscoveredCompanies()).length - staged;
      li.pages += summary.pagesFetched || 0;
      li.found += found;
      li.bands.push({ key: band.key, label: band.label, wanted: band.count, found, pages: summary.pagesFetched || 0 });
      for (const k of ["excludedByBlocklist", "excludedByOrganizationType", "excludedByAliasDuplicate", "excludedByAlreadyInWorkbook", "excludedByLocation", "skippedNoId"]) {
        li.excluded[k] = (li.excluded[k] || 0) + (summary[k] || 0);
      }
      li.unscopedCountries = summary.unscopedCountries || [];
      li.unscopedIndustries = summary.unscopedIndustries || [];
      if (summary.stoppedByTouchBudget) li.touchLimit = true;
      await save();
    } });
  } catch (err) {
    if (!(err instanceof BatchBusyError)) throw err;
    li.busy = true; // another job took LinkedIn in the moment between the wait and the lock
    li.ran = false;
  } finally {
    // Only the company part of the old Discovery is used here: contacts are the pipeline's job.
    await resetDiscoveryQueue().catch(() => {});
  }
  state.phase = "Adding the LinkedIn companies";
  await save();
  const merged = await autoMergeDiscoveryResults();
  li.nameMatchesWaiting = merged.nameMatchesWaiting || 0;
  const rows = ((await getTargetAccountsWorkbook()).companies || []).filter((r) => r.companyId && !before.has(r.companyId));
  li.added = rows.length;
  li.addedNames = rows.map((r) => r.company);
  await save();
  return { keys: rows.map((r) => normalizeCompanyName(r.company)), companyIds: rows.map((r) => r.companyId) };
}

// ---- Web part ----

async function webPart({ apiKey, universe, bands, state, save, signal, stop, countries, wanted }) {
  const stopped = () => signal.aborted;
  const settings = {
    apiKey, companyContext: await getCompanyContext(), idealCustomerProfile: await getIdealCustomerProfile(),
    outputLanguage: await getOutputLanguage(), targetCountries: state.countries,
  };
  const targets = bandTargets(universe.sizeBuckets, bands, wanted);
  const ticked = bands.filter((b) => universe.sizeBuckets?.[b.key]?.checked);
  const bandsText = (ticked.length ? ticked : bands).map(bandText).join(", ");
  const largest = targetsLargest(universe.sizeBuckets, bands);
  const industryNames = (universe.industries || []).map((i) => i && i.name).filter(Boolean);
  const eligibility = await getOrganizationTypeEligibility();
  const filterCtx = {
    seller: { name: (await getSellerCompanyName()) || null, website: await getCompanyWebsite() },
    exclusions: await getExclusionMatcher(),
    known: buildKnownCompanies(await getDiscoveryKnownAccounts()), // includes what the LinkedIn part just added
    sizeBuckets: universe.sizeBuckets, bands, industryNames,
    excludedOrgTypes: Object.entries(eligibility || {}).filter(([, v]) => v === "no").map(([k]) => k),
  };
  const pool = [];
  const dropped = [];
  const poolFull = () => pool.length >= Math.ceil(wanted * POOL_FACTOR);
  const overBudget = () => state.budget > 0 && state.spent >= state.budget;
  let failuresInARow = 0;

  // One web call, measured and recorded; a rate limit waits a minute and tries once more.
  const call = async (kind, what, fn) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (stopped()) return null;
      if (overBudget()) { stop("budget"); return null; }
      try {
        const r = await fn();
        state.spent += r.costUsd || 0;
        state.calls.push({ kind, what, costUsd: r.costUsd || 0, seconds: Math.round(r.ms / 1000), searches: r.searches, fetches: r.fetches, stopped: r.stopped || null });
        failuresInARow = 0;
        await save();
        return r;
      } catch (err) {
        if (stopped()) return null;
        const blocked = apiBlockedReason(err);
        if (blocked) { state.lastError = err.message; stop(blocked); return null; }
        if ((err.rateLimited || err.status === 429 || err.status === 529) && attempt === 0) {
          state.phase = "Paused - Anthropic asked us to slow down; trying again in a minute";
          await save();
          await new Promise((r) => setTimeout(r, RATE_LIMIT_WAIT_MS));
          continue;
        }
        state.lastError = err.message;
        state.calls.push({ kind, what, error: String(err.message || err).slice(0, 200) });
        if (++failuresInARow >= 3 || [401, 402, 403].includes(err.status)) stop("errors");
        await save();
        return null;
      }
    }
    return null;
  };

  const take = (rawRows, sourceUrl, isFit) => {
    const cleaned = rawRows.map((r) => cleanListingRow(r, sourceUrl));
    state.rowsRead += cleaned.length;
    if (isFit) state.fitRows += cleaned.length;
    const f = filterListingRows(cleaned, filterCtx);
    pool.push(...f.kept);
    dropped.push(...f.dropped);
    state.kept = pool.length;
    state.dropped = dropCounts(dropped);
    return f;
  };

  // Listings, country by country, until the pool is full.
  for (const country of countries) {
    if (stopped() || poolFull()) break;
    state.phase = `Looking for listing pages on the web - ${country}`;
    await save();
    const found = await call("find", country, () => findDiscoveryListings({ country, bandsText, largest, industryNames, wanted }, settings, { signal }));
    if (!found) continue;
    for (const listing of found.listings.slice(0, MAX_LISTINGS_PER_COUNTRY)) {
      if (stopped() || poolFull()) break;
      state.phase = `Reading a listing (${country}): ${listing.what || listing.url}`;
      await save();
      const maxRows = Math.min(MAX_ROWS_PER_LISTING, Math.max(30, Math.ceil(wanted * POOL_FACTOR * 2)));
      const read = await call("read", listing.url, () => readDiscoveryListing(listing, { country, industryNames, maxRows }, settings, { signal }));
      const rec = { country, url: listing.url, what: listing.what, rows: 0, kept: 0, costUsd: 0 };
      if (read) {
        const f = take(read.rows, listing.url, false);
        Object.assign(rec, { rows: read.rows.length, kept: f.kept.length, costUsd: read.costUsd || 0, seconds: Math.round(read.ms / 1000), cutOff: read.stopped === "timeout" });
      } else rec.failed = true;
      state.listings.push(rec);
      await save();
    }
  }

  // The fit search, when the listings ran short (also finds local branches of international groups).
  for (const country of countries) {
    if (stopped() || pool.length >= wanted) break;
    state.phase = `Searching the web for companies that fit you - ${country}`;
    await save();
    const maxRows = Math.min(40, wanted - pool.length + 10);
    const fit = await call("fit", country, () => fitSearchDiscovery({ country, bandsText, industryNames, maxRows, avoid: pool.map((r) => r.name) }, settings, { signal }));
    if (fit) take(fit.rows, null, true);
  }

  // Choose and add. A stop by the user adds nothing; a budget stop adds what was found.
  if (state.stoppedReason === "user") return { keys: [], companyIds: [] };
  state.phase = "Adding the web companies";
  await save();
  for (const r of pool) {
    const match = industryNames.find((n) => n.toLowerCase() === String(r.industryMatch || "").toLowerCase());
    r.preScore = computeCompanyDeterministicPreScore({ globalHqCountry: r.hqCountry, globalEmployees: r.employees, industry: match || r.industry }, 0, universe).score;
  }
  const chosen = chooseDiscoveryRows(pool, targets, wanted);
  if (chosen.length === 0) return { keys: [], companyIds: [] };
  const res = await addWebDiscoveredCompanies(chosen, { runAt: state.startedAt });
  state.webAdded = res.added.length;
  state.skipped = res.skipped;
  state.addedNames = res.added.map((a) => a.company);
  return { keys: res.added.map((a) => a.key), companyIds: res.added.map((a) => a.companyId) };
}
