// Keeps count of what SalesTeam's calls to Anthropic (your own API key) use: tokens, web searches and an ESTIMATED cost in
// US dollars, per day, split into "Web research" and "Other AI features". The Anthropic Console is the official figure;
// this is an estimate from Anthropic's published prices, and only counts calls made by this extension.
//
// Prices are US$ per million tokens. Web search is priced per search. Unknown models are priced like Claude Sonnet.
const PRICES_PER_MILLION = {
  "claude-fable-5": { in: 10, out: 50 },
  "claude-fable-5-1": { in: 10, out: 50 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-opus-4": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-sonnet-4": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};
const DEFAULT_PRICE = { in: 2, out: 10 };
export const WEB_SEARCH_USD_EACH = 0.01; // Anthropic's published rate: about US$10 per 1,000 searches

const USAGE_KEY = "apiUsage";

// The user's own calendar day (not UTC), as YYYY-MM-DD.
export function localDayKey(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
const KEEP_DAYS = 400;

function priceFor(model) {
  const id = String(model || "");
  const match = Object.keys(PRICES_PER_MILLION).sort((a, b) => b.length - a.length).find((k) => id.startsWith(k));
  return match ? PRICES_PER_MILLION[match] : DEFAULT_PRICE;
}

// usage: the "usage" object of an Anthropic response ({input_tokens, output_tokens, cache_read_input_tokens,
// cache_creation_input_tokens, server_tool_use: {web_search_requests}}), plus an optional `searches` override.
export function estimateCostUsd(model, usage = {}) {
  const p = priceFor(model);
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const searches = usage.searches ?? usage.server_tool_use?.web_search_requests ?? 0;
  const tokenUsd = (input * p.in + output * p.out + cacheRead * p.in * 0.1 + cacheWrite * p.in * 1.25) / 1e6;
  return { tokenUsd, searchUsd: searches * WEB_SEARCH_USD_EACH, totalUsd: tokenUsd + searches * WEB_SEARCH_USD_EACH, searches };
}

function emptyBucket() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, searches: 0, usd: 0 };
}

let queue = Promise.resolve();

// kind: "webResearch" or "other"; feature: a short name of the feature that made the call (for the record only).
export function recordApiUsage(kind, feature, model, usage) {
  if (!usage) return Promise.resolve(null);
  const cost = estimateCostUsd(model, usage);
  const day = localDayKey();
  queue = queue.then(async () => {
    try {
      const data = (await chrome.storage.local.get(USAGE_KEY))[USAGE_KEY] || { days: {} };
      const days = data.days || {};
      const d = days[day] || { webResearch: emptyBucket(), other: emptyBucket(), byFeature: {} };
      const bucket = d[kind === "webResearch" ? "webResearch" : "other"];
      bucket.calls += 1;
      bucket.inputTokens += usage.input_tokens || 0;
      bucket.outputTokens += usage.output_tokens || 0;
      bucket.cacheTokens += (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      bucket.searches += cost.searches;
      bucket.usd += cost.totalUsd;
      const f = d.byFeature[feature] || { calls: 0, usd: 0 };
      f.calls += 1;
      f.usd += cost.totalUsd;
      f.inputTokens = (f.inputTokens || 0) + (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      f.outputTokens = (f.outputTokens || 0) + (usage.output_tokens || 0);
      f.searches = (f.searches || 0) + cost.searches;
      d.byFeature[feature] = f;
      days[day] = d;
      const keys = Object.keys(days).sort();
      while (keys.length > KEEP_DAYS) delete days[keys.shift()];
      await chrome.storage.local.set({ [USAGE_KEY]: { days } });
    } catch { /* usage counting must never break the feature that made the call */ }
    return cost;
  });
  return queue;
}

export async function getApiUsage() {
  const data = (await chrome.storage.local.get(USAGE_KEY))[USAGE_KEY] || { days: {} };
  return data.days || {};
}

// Sums the given days into { webResearch, other, total } buckets.
export function sumDays(days, dayKeys) {
  const out = { webResearch: emptyBucket(), other: emptyBucket() };
  for (const k of dayKeys) {
    const d = days[k];
    if (!d) continue;
    for (const kind of ["webResearch", "other"]) {
      for (const field of Object.keys(out[kind])) out[kind][field] += d[kind]?.[field] || 0;
    }
  }
  const total = emptyBucket();
  for (const field of Object.keys(total)) total[field] = out.webResearch[field] + out.other[field];
  return { ...out, total };
}

export async function clearApiUsage() {
  await chrome.storage.local.remove(USAGE_KEY);
}

// ---- Warning before an action that could cost a lot (the limit is set in Settings > Billing; 0 switches it off) ----
const COST_WARNING_KEY = "costWarningUsd";
export const DEFAULT_COST_WARNING_USD = 2;

export async function getCostWarningUsd() {
  const v = (await chrome.storage.local.get(COST_WARNING_KEY))[COST_WARNING_KEY];
  return typeof v === "number" && v >= 0 ? v : DEFAULT_COST_WARNING_USD;
}

export async function saveCostWarningUsd(value) {
  await chrome.storage.local.set({ [COST_WARNING_KEY]: Math.max(0, Number(value) || 0) });
}

// Rough, deliberately generous cost of one item of a batch AI action, in US$ (Claude Sonnet prices).
const PER_ITEM_USD = { leadScoring: 0.003, companyExtraction: 0.002, companyFit: 0.003 };

export function estimateBatchCostUsd(kind, count) {
  return (PER_ITEM_USD[kind] || 0.003) * count;
}

// True when the action may go ahead: its estimated cost is under the user's warning limit, or the user confirmed anyway.
export async function confirmIfCostly(kind, count, actionLabel, askConfirm) {
  const limit = await getCostWarningUsd();
  const estimate = estimateBatchCostUsd(kind, count);
  if (limit <= 0 || estimate < limit) return true;
  return askConfirm(
    `${actionLabel} could cost about $${estimate.toFixed(2)} on your Anthropic API key - more than your warning limit of $${limit.toFixed(2)}.\n\n` +
    "This is a rough estimate; your Anthropic Console shows the real cost. You can change or switch off this warning in Settings > Billing.\n\nContinue?",
    { okLabel: "Continue", cancelLabel: "Cancel" });
}
