// The extension's service worker: orchestrates a full scan run (scanAllTopics)
// across every configured Topic and Job Topic. For each one, chunks its
// keyword list into multiple LinkedIn search URLs if needed (LinkedIn caps
// query length), sequentially navigates a background tab to each, and waits
// for content-script.js/jobs-content-script.js to scrape and report results -
// every wait is wrapped in withKeepAlive() so Chrome doesn't kill this service
// worker as idle mid-scan. Results are merged, deduped, ranked, and negative
// topics are (re-)applied before saving.
import {
  getTopics,
  getJobTopics,
  getResults,
  saveResults,
  mergeTopicPosts,
  mergeJobPosts,
  getTimeframe,
  getJobSearchEnabled,
  getJobSearchUsePostTopics,
  getJobSearchLocation,
  getJobSearchTimeframe,
  saveLastScanStartedAt,
  getNegativeTopics,
  applyNegativeTopicsToResultsMap,
  containsWholeWord,
  getAnthropicApiKey,
  getCompanyContext,
  getIdealCustomerProfile,
  getMentorPersona,
  getOutputLanguage,
  normalizeCompanyName,
} from "./storage.js";
import { sortResultsByRelevance } from "./ranking.js";
import { prioritizeLeads, PRIORITY_LEVELS, extractCompaniesForLeads } from "./agent-shared.js";

const SCRAPE_TIMEOUT_MS = 15000;
// Used only for the two independent AND-group searches below (concept-only,
// activity-only) - their deeper scroll (DEEP_MAX_SCROLL_PASSES, see
// content-script.js) can legitimately take longer than a normal search's
// scroll-until-plateau, and this must stay comfortably above that worst
// case or waitForScrapeResult would time out mid-scroll and silently return
// [] before the content script ever gets to send its result.
const DEEP_SCRAPE_TIMEOUT_MS = 60000;
const MIN_DELAY_MS = 3000;
const MAX_DELAY_MS = 8000;

// Confirmed empirically: a single parenthesized OR-group in LinkedIn's
// keyword search tops out at 6 terms (6 works, 7 silently returns zero, no
// error). A topic's keywords are its primary OR-group; it can optionally
// have a second "andKeywords" OR-group requiring a post to ALSO mention one
// of those (e.g. concept terms AND activity terms). Rather than combining
// both groups into one query (which used to require shrinking both to share
// a 9-term combined-query cap, forcing a cartesian product of concept-chunks
// x activity-chunks - a 23x23 topic cost 30 sub-queries), each group is
// searched independently as its own plain OR list, and the AND is applied
// client-side by intersecting the two raw result sets on post key (see the
// scan loop below) - same logical AND, additive cost instead of
// multiplicative. Location/author-title filters are deliberately NOT sent to
// LinkedIn at all (see content-script.js) - they're applied client-side
// against each post's scraped headline instead.
const MAX_OR_TERMS = 6;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

function chunk(array, size) {
  if (array.length === 0) return [[]];
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function buildSearchUrl(conceptChunk, activityChunk, timeframe) {
  const toClauses = (list) =>
    list.filter((k) => k.trim().length > 0).map((k) => (k.includes(" ") ? `"${k.trim()}"` : k.trim()));

  let query = toClauses(conceptChunk).join(" OR ");
  if (activityChunk && activityChunk.length > 0) {
    query = `(${query}) AND (${toClauses(activityChunk).join(" OR ")})`;
  }

  const sortBy = encodeURIComponent('["relevance"]');
  let url = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(query)}&origin=FACETED_SEARCH&sortBy=${sortBy}`;
  if (timeframe && timeframe !== "any") {
    url += `&datePosted=${encodeURIComponent(`["${timeframe}"]`)}`;
  }
  return url;
}

// No shared-budget splitting needed anymore - each group is chunked
// independently at the same MAX_OR_TERMS, since they're never combined into
// one query. activityChunks is genuinely empty (not [[]]) when the topic has
// no AND group, so `.length === 0` cleanly distinguishes the two paths in
// the scan loop below.
function planTopicChunks(topic) {
  const activityKeywords = topic.andKeywords || [];
  return {
    conceptChunks: chunk(topic.keywords, MAX_OR_TERMS),
    activityChunks: activityKeywords.length > 0 ? chunk(activityKeywords, MAX_OR_TERMS) : [],
  };
}

// Jobs search uses a completely different LinkedIn system than Posts (own
// URL, own filters: geoId for location, f_TPR for date posted in seconds -
// r86400/r604800/r2592000 for 24h/week/month). We haven't separately
// confirmed Jobs' own term-complexity limit, so this reuses the same
// MAX_OR_TERMS=6 assumption that's confirmed for Posts as a safe starting
// point - a single 6-term job search was tested live and worked.
const JOB_TPR_SECONDS = { "past-24h": 86400, "past-week": 604800, "past-month": 2592000 };

function buildJobSearchUrl(keywordChunk, geoId, timeframe) {
  const clauses = keywordChunk
    .filter((k) => k.trim().length > 0)
    .map((k) => (k.includes(" ") ? `"${k.trim()}"` : k.trim()));
  const query = clauses.join(" OR ");

  let url = `https://www.linkedin.com/jobs/search-results/?keywords=${encodeURIComponent(query)}`;
  if (geoId) url += `&geoId=${encodeURIComponent(geoId)}`;
  const seconds = JOB_TPR_SECONDS[timeframe];
  if (seconds) url += `&f_TPR=r${seconds}`;
  return url;
}

function waitForJobScrapeResult(topicId) {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        chrome.runtime.onMessage.removeListener(listener);
        resolve([]);
      }
    }, SCRAPE_TIMEOUT_MS);

    function listener(message) {
      if (message?.type === "JOB_SCRAPE_RESULT" && message.topicId === topicId && !settled) {
        settled = true;
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(message.jobs || []);
      }
    }
    chrome.runtime.onMessage.addListener(listener);
  });
}

function fullTopicMatchedJobKeywords(job, topic) {
  const allKeywords = [...topic.keywords, ...(topic.andKeywords || [])];
  const haystack = `${job.title} ${job.company}`.toLowerCase();
  return allKeywords.filter((kw) => containsWholeWord(haystack, kw));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

// Breaks a delay into short chunks with a trivial storage read between each,
// instead of one continuous setTimeout. Manifest V3 service workers can be
// terminated by Chrome after a period with no extension-API activity - a
// long scan's cumulative delay time sitting as one idle wait is a plausible
// cause of a scan silently freezing partway through with no error ever
// shown (each API touch here resets that idle clock). Best-effort mitigation,
// not a guaranteed fix - Chrome doesn't document the exact idle threshold.
async function keepAliveSleep(totalMs) {
  const STEP_MS = 5000;
  let remaining = totalMs;
  while (remaining > 0) {
    const step = Math.min(STEP_MS, remaining);
    await sleep(step);
    await chrome.storage.local.get("keepAlive").catch(() => {});
    remaining -= step;
  }
}

// Same idea as keepAliveSleep above, but for a wait we don't control the
// length of (navigation, waiting on the content script) rather than our own
// deliberate delay. Without this, a single slow page load - a proxy, a
// managed/monitored corporate network, anything that pushes navigateAndWait
// or waitForScrapeResult close to their own timeouts - can leave the service
// worker with 15-20+ seconds of zero extension-API activity, which is
// exactly the condition Chrome uses to decide it's safe to kill an MV3
// service worker. If that happens mid-scan, the side panel is left waiting
// on a message that will never arrive, since the process that would have
// sent it no longer exists - indistinguishable from "the scan is stuck."
// Pinging storage every few seconds while ANY of these waits are pending
// keeps the worker's idle clock from ever reaching that point.
async function withKeepAlive(promise) {
  const interval = setInterval(() => {
    chrome.storage.local.get("keepAlive").catch(() => {});
  }, 4000);
  try {
    return await promise;
  } finally {
    clearInterval(interval);
  }
}

// A timeout fallback here matters: with none, a page that never fires
// "complete" (a proxy, a corporate security interstitial, an unusually slow
// or managed network - all plausible causes that wouldn't show up on every
// machine) hangs this forever with nothing ever thrown, so even the error
// handling around the scan's main loop can't catch or report it - the scan
// just sits stuck with no message, indistinguishable from before that fix
// existed. Proceeding anyway after a timeout means the content script gets
// a chance to scrape whatever did load, rather than blocking the whole scan.
const NAVIGATION_TIMEOUT_MS = 20000;

function navigateAndWait(tabId, url) {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }, NAVIGATION_TIMEOUT_MS);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete" && !settled) {
        settled = true;
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    // Register the listener before navigating so a fast page load can't
    // fire "complete" before we're listening for it.
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url });
  });
}

function waitForScrapeResult(topicId, timeoutMs = SCRAPE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        chrome.runtime.onMessage.removeListener(listener);
        resolve([]);
      }
    }, timeoutMs);

    function listener(message) {
      if (message?.type === "SCRAPE_RESULT" && message.topicId === topicId && !settled) {
        settled = true;
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(message.posts || []);
      }
    }
    chrome.runtime.onMessage.addListener(listener);
  });
}

function broadcastProgress(current, total, topicName) {
  chrome.runtime.sendMessage({ type: "SCAN_PROGRESS", current, total, topicName }).catch(() => {});
}

// Re-checks a post against the topic's FULL keyword lists (both groups),
// not just the specific chunk that happened to be searched when this post
// was found. A topic's keywords get split into multiple sub-searches, so
// the chunk that surfaced a given post is only a subset of everything you
// actually configured for that topic - this shows every configured keyword
// that's genuinely present in the text, not just the ones from that one
// sub-search.
function fullTopicMatchedKeywords(post, topic) {
  const allKeywords = [...topic.keywords, ...(topic.andKeywords || [])];
  const haystack = `${post.snippet} ${post.headline}`.toLowerCase();
  return allKeywords.filter((kw) => containsWholeWord(haystack, kw));
}

// Used when the same post surfaces more than once for one side of an
// AND-topic's two independent searches (once within a phase's own chunk
// loop, and again when merging the concept/activity phases together) -
// keeps whichever occurrence has the lower (more relevant) rank instead of
// letting a later chunk silently overwrite a better one.
function keepBestRank(map, post) {
  const existing = map.get(post.key);
  if (!existing || post.rank < existing.rank) map.set(post.key, post);
}

async function scanAllTopics({ reapplyToExisting = false } = {}) {
  const allTopics = await getTopics();
  const topics = allTopics.filter((topic) => topic.enabled !== false);
  if (topics.length === 0) {
    chrome.runtime
      .sendMessage({
        type: "SCAN_ERROR",
        message:
          allTopics.length === 0
            ? "No topics configured."
            : "All topics are disabled - enable at least one to scan.",
      })
      .catch(() => {});
    return;
  }

  const existingResults = await getResults();
  const preScanKeys = new Set(Object.keys(existingResults));
  let tab = null;
  let previouslyActiveTab = null;

  // Recorded before scraping starts (not after it finishes) so the
  // Dashboard's "NEW" flag and "First Scanned" column stay correct even if
  // this scan later errors out partway through - every lead progressively
  // saved up to that point still counts as part of this scan.
  await saveLastScanStartedAt(Date.now());

  try {
    const timeframe = await getTimeframe();
    const negativeTopics = await getNegativeTopics();

    const jobSearchEnabled = await getJobSearchEnabled();
    const jobSearchLocation = await getJobSearchLocation();
    const jobSearchTimeframe = await getJobSearchTimeframe();

    // Job Search's topics are additive with Posts', not either/or: job-only
    // topics (e.g. "AI Engineer" OR "ML Engineer") always apply, and this
    // toggle controls whether the enabled Post topics ALSO get searched in
    // Jobs on top of those.
    const jobSearchUsePostTopics = await getJobSearchUsePostTopics();
    const allJobTopics = await getJobTopics();
    const enabledJobOnlyTopics = allJobTopics.filter((topic) => topic.enabled !== false);
    const jobTopics = jobSearchUsePostTopics ? [...topics, ...enabledJobOnlyTopics] : enabledJobOnlyTopics;

    // Jobs search reuses each topic's combined keywords (both groups treated
    // as one flat OR list - job titles/descriptions are concise enough that
    // the concept/activity AND-split built for Posts isn't needed here).
    const jobKeywordChunks = jobSearchEnabled
      ? jobTopics.map((topic) => chunk([...topic.keywords, ...(topic.andKeywords || [])], MAX_OR_TERMS))
      : [];

    const topicChunkPlans = topics.map(planTopicChunks);
    const postSubQueries = topicChunkPlans.reduce(
      (sum, plan) => sum + plan.conceptChunks.length + plan.activityChunks.length,
      0
    );
    const jobSubQueries = jobKeywordChunks.reduce((sum, chunks) => sum + chunks.length, 0);
    const totalSubQueries = postSubQueries + jobSubQueries;

    tab = await chrome.tabs.create({ url: "about:blank", active: false });

    let completed = 0;
    for (let i = 0; i < topics.length; i++) {
      const topic = topics[i];
      const { conceptChunks, activityChunks } = topicChunkPlans[i];

      await chrome.storage.local.set({
        currentScanTopicId: topic.id,
        currentScanTopicName: topic.name,
      });

      if (activityChunks.length === 0) {
        // Plain OR-topic - unchanged: one flat chunk loop, merged immediately
        // per sub-query.
        for (const conceptChunk of conceptChunks) {
          completed++;
          broadcastProgress(completed, totalSubQueries, topic.name);

          await chrome.storage.local.set({ currentScanKeywords: conceptChunk });
          await withKeepAlive(navigateAndWait(tab.id, buildSearchUrl(conceptChunk, [], timeframe)));

          const posts = await withKeepAlive(waitForScrapeResult(topic.id));
          for (const post of posts) {
            post.matchedKeywords = fullTopicMatchedKeywords(post, topic);
          }
          console.log(`[SalesTeam] topic "${topic.name}" (sub-query ${completed}/${totalSubQueries}):`, conceptChunk);
          for (const post of posts) {
            console.log(`  - ${post.author}: matchedKeywords=`, post.matchedKeywords, `snippet="${post.snippet.slice(0, 100)}"`);
          }
          mergeTopicPosts(existingResults, topic, posts, negativeTopics);

          if (completed < totalSubQueries) {
            await keepAliveSleep(randomDelay());
          }
        }
      } else {
        // AND-topic - concept and activity groups searched independently
        // (each a plain OR list, never combined into one query), then
        // joined client-side on post key. Scraped deeper and given a longer
        // scrape timeout (currentScanDeepScroll, DEEP_SCRAPE_TIMEOUT_MS)
        // since each phase is a broader single-constraint search than the
        // old combined query, and a real double-match needs to survive
        // being scraped from a bigger, less-targeted result pool.
        const conceptMatches = new Map();
        const activityMatches = new Map();

        for (const conceptChunk of conceptChunks) {
          completed++;
          broadcastProgress(completed, totalSubQueries, topic.name);

          await chrome.storage.local.set({ currentScanKeywords: conceptChunk, currentScanDeepScroll: true });
          await withKeepAlive(navigateAndWait(tab.id, buildSearchUrl(conceptChunk, [], timeframe)));
          const posts = await withKeepAlive(waitForScrapeResult(topic.id, DEEP_SCRAPE_TIMEOUT_MS));
          for (const post of posts) keepBestRank(conceptMatches, post);

          if (completed < totalSubQueries) {
            await keepAliveSleep(randomDelay());
          }
        }

        for (const activityChunk of activityChunks) {
          completed++;
          broadcastProgress(completed, totalSubQueries, topic.name);

          await chrome.storage.local.set({ currentScanKeywords: activityChunk, currentScanDeepScroll: true });
          await withKeepAlive(navigateAndWait(tab.id, buildSearchUrl(activityChunk, [], timeframe)));
          const posts = await withKeepAlive(waitForScrapeResult(topic.id, DEEP_SCRAPE_TIMEOUT_MS));
          for (const post of posts) keepBestRank(activityMatches, post);

          if (completed < totalSubQueries) {
            await keepAliveSleep(randomDelay());
          }
        }

        const intersected = [];
        for (const [key, conceptPost] of conceptMatches) {
          const activityPost = activityMatches.get(key);
          if (!activityPost) continue;
          const post = { ...conceptPost, rank: Math.min(conceptPost.rank, activityPost.rank) };
          post.matchedKeywords = fullTopicMatchedKeywords(post, topic);
          intersected.push(post);
        }
        console.log(
          `[SalesTeam] topic "${topic.name}": ${conceptMatches.size} concept match(es), ` +
          `${activityMatches.size} activity match(es), ${intersected.length} intersected (real AND match(es)).`
        );
        for (const post of intersected) {
          console.log(`  - ${post.author}: matchedKeywords=`, post.matchedKeywords, `snippet="${post.snippet.slice(0, 100)}"`);
        }
        mergeTopicPosts(existingResults, topic, intersected, negativeTopics);
      }

      await chrome.storage.local.remove(["currentScanTopicId", "currentScanTopicName", "currentScanDeepScroll"]);
      // Checkpoint after each topic, not just at the very end - so a later
      // failure/timeout doesn't lose everything found so far in this scan.
      await saveResults(existingResults);
    }

    if (jobSearchEnabled && jobTopics.length > 0) {
      // LinkedIn's Jobs list is a viewport-virtualized component - unlike the
      // Posts feed, it appears to render zero items when its tab has never
      // been visible/laid out (confirmed empirically: 0 jobs across 8 varied
      // queries that should have had real matches). Bring the tab to the
      // foreground just for this phase, then restore whatever was focused
      // before the scan started.
      [previouslyActiveTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.tabs.update(tab.id, { active: true });

      for (let i = 0; i < jobTopics.length; i++) {
        const topic = jobTopics[i];
        const keywordChunks = jobKeywordChunks[i];
        if (keywordChunks.length === 0) continue;

        await chrome.storage.local.set({
          currentJobScanTopicId: topic.id,
          currentJobScanTopicName: topic.name,
        });

        for (const keywordChunk of keywordChunks) {
          completed++;
          broadcastProgress(completed, totalSubQueries, `${topic.name} (Jobs)`);

          await chrome.storage.local.set({ currentJobScanKeywords: keywordChunk });
          await withKeepAlive(navigateAndWait(tab.id, buildJobSearchUrl(keywordChunk, jobSearchLocation, jobSearchTimeframe)));

          const jobs = await withKeepAlive(waitForJobScrapeResult(topic.id));
          for (const job of jobs) {
            job.matchedKeywords = fullTopicMatchedJobKeywords(job, topic);
          }
          console.log(`[SalesTeam] job search topic "${topic.name}" (sub-query ${completed}/${totalSubQueries}), keywords:`, keywordChunk);
          for (const job of jobs) {
            console.log(`  - "${job.title}" @ ${job.company}: matchedKeywords=`, job.matchedKeywords);
          }
          mergeJobPosts(existingResults, topic, jobs, negativeTopics);

          if (completed < totalSubQueries) {
            await keepAliveSleep(randomDelay());
          }
        }

        await chrome.storage.local.remove(["currentJobScanTopicId", "currentJobScanTopicName"]);
        // Checkpoint after each job topic too, same reasoning as above.
        await saveResults(existingResults);
      }
    }

    // Opt-in, per the side panel's "Also apply..." checkbox: a negative
    // topic edited/added since older leads were scanned only affects NEW
    // leads by default (see mergeTopicPosts/mergeJobPosts above) - this
    // bidirectionally re-checks every "New" and "Irrelevant" existing lead
    // too (see applyNegativeTopicsToResultsMap), right on the same in-memory
    // existingResults the rest of this function is using (not a separate
    // storage round-trip), so the prioritization step below never wastes a
    // call scoring a lead that's about to become Irrelevant anyway.
    if (reapplyToExisting) {
      applyNegativeTopicsToResultsMap(existingResults, negativeTopics);
      await saveResults(existingResults);
    }

    // Best-effort company extraction for Post leads (Job leads already get a
    // clean `company` straight from the scrape) - run before prioritization
    // so it's available to any later reader this same scan. Never touches a
    // lead that already has a company, whether scraped, extracted here on an
    // earlier scan, or manually assigned (storage.js's setLeadCompany) - a
    // scan can never clobber a human's correction.
    const toExtractCompany = Object.values(existingResults).filter((r) => r.type !== "job" && !r.company);
    if (toExtractCompany.length > 0) {
      const apiKeyForExtraction = await getAnthropicApiKey();
      if (apiKeyForExtraction) {
        try {
          const extracted = await extractCompaniesForLeads(toExtractCompany, { apiKey: apiKeyForExtraction });
          const extractedAt = Date.now();
          for (const { key, company } of extracted) {
            if (existingResults[key] && !existingResults[key].company && company && company.trim()) {
              existingResults[key].company = company.trim();
              existingResults[key].companyExtractedAt = extractedAt;
            }
          }
          await saveResults(existingResults);
        } catch (err) {
          // Never fails the scan - company extraction is an enhancement, same as prioritization below.
          console.error("[SalesTeam] Company extraction failed (non-fatal):", err);
        }
      }
    }

    // Post-processing, after every search (and the negative-topic blocking
    // baked into mergeTopicPosts/mergeJobPosts above, plus the optional
    // re-apply pass just above) is done - only ever scores leads that are
    // still "New" and don't already have a priority, so a lead a person
    // already acted on, or already scored in an earlier scan, is never
    // re-scored or overwritten.
    const toPrioritize = Object.values(existingResults).filter((r) => r.status === "New" && !r.priority);

    // A brand-new lead this scan might be a second signal about someone/
    // somewhere already scored - the same person posting again (Post leads,
    // matched by profileUrl) or another opening at the same company (Job
    // leads, matched by normalized company). If so, re-score the existing
    // lead alongside the new one, since a second signal can change the right
    // priority. Only ever considers already-"New" leads - anything the
    // salesperson has acted on (Contacted/Dismissed/Responded/Converted) or
    // Irrelevant is never touched, same invariant as the base filter above.
    const freshKeys = new Set(toPrioritize.map((r) => r.key));
    for (const existing of Object.values(existingResults)) {
      // priorityScoredAt (not just priority) required - a manually-set
      // priority (setLeadPriority in storage.js) deliberately clears it, so
      // a correlated new signal can never silently override a human's call.
      if (existing.status !== "New" || !existing.priorityScoredAt || freshKeys.has(existing.key)) continue;
      const correlates = toPrioritize.some((fresh) => {
        if (existing.type === "job" || fresh.type === "job") {
          if (existing.type !== "job" || fresh.type !== "job") return false;
          const existingCompany = normalizeCompanyName(existing.company);
          return existingCompany && existingCompany === normalizeCompanyName(fresh.company);
        }
        return Boolean(existing.profileUrl) && existing.profileUrl === fresh.profileUrl;
      });
      if (correlates) toPrioritize.push(existing);
    }

    if (toPrioritize.length > 0) {
      const apiKey = await getAnthropicApiKey();
      if (apiKey) {
        chrome.runtime.sendMessage({ type: "SCAN_PRIORITIZING", count: toPrioritize.length }).catch(() => {});
        try {
          const settings = {
            apiKey,
            mentorPersona: await getMentorPersona(),
            companyContext: await getCompanyContext(),
            idealCustomerProfile: await getIdealCustomerProfile(),
            outputLanguage: await getOutputLanguage(),
          };
          const priorities = await prioritizeLeads(toPrioritize, settings);
          const scoredAt = Date.now();
          for (const { key, priority, reason } of priorities) {
            if (existingResults[key] && PRIORITY_LEVELS.includes(priority)) {
              existingResults[key].priority = priority;
              existingResults[key].priorityReason = reason || "";
              existingResults[key].priorityScoredAt = scoredAt;
            }
          }
          await saveResults(existingResults);
        } catch (err) {
          // Never fails the scan itself - the leads are already found and
          // saved either way, prioritization is an enhancement on top.
          console.error("[SalesTeam] Lead prioritization failed (non-fatal):", err);
        }
      }
    }

    const sorted = sortResultsByRelevance(existingResults).map((r) => ({
      ...r,
      isNew: !preScanKeys.has(r.key),
    }));
    chrome.runtime.sendMessage({ type: "SCAN_COMPLETE", results: sorted }).catch(() => {});
  } catch (err) {
    // Without this, any error here (a closed tab, a transient extension API
    // failure, Chrome terminating this service worker mid-run - a known
    // Manifest V3 risk for long-running background tasks) used to kill the
    // scan silently: no message ever reached the side panel, the Scan
    // button stayed disabled forever, and everything found in that run was
    // lost since results were only saved at the very end.
    console.error("[SalesTeam] Scan failed:", err);
    await saveResults(existingResults).catch(() => {});
    chrome.runtime
      .sendMessage({
        type: "SCAN_ERROR",
        message:
          `Scan stopped early due to an error (${err?.message || err}). Leads found before the error ` +
          "were saved - check Results, then try scanning again to pick up the rest.",
      })
      .catch(() => {});
  } finally {
    if (previouslyActiveTab) {
      await chrome.tabs.update(previouslyActiveTab.id, { active: true }).catch(() => {});
    }
    if (tab) {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "SCAN_ALL") {
    scanAllTopics({ reapplyToExisting: Boolean(message.reapplyToExisting) });
  }
});
