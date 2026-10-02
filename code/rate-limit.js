// How a web-research run backs off when the Anthropic API says "too many requests" (1.2.1 build step 0,
// ONBOARDING_RESEARCH_DESIGN.md 5.6). Pure - no chrome.*, no DOM - so test_pure_modules.py runs it for real.
// A rate limit is no reason to end a run: the account goes back in the queue, every worker pauses, and the
// run resumes when the wait is over. Only a long streak of them in a row stops it.

export const BACKOFF_FIRST_MS = 30 * 1000;
export const BACKOFF_MAX_MS = 5 * 60 * 1000;
export const MAX_RATE_LIMITS_IN_A_ROW = 5;

// 429 = rate limit, 529 = Anthropic overloaded: both say "try again shortly", not "this request is wrong".
// `rateLimited` is set by agent-shared.js when the web search tool itself reports too_many_requests.
export function isRateLimited(err) {
  return !!err && (err.status === 429 || err.status === 529 || err.rateLimited === true);
}

// How long to wait before the next try. `retryAfter` is the response's retry-after header (seconds, or an
// HTTP date) and wins when present; otherwise 30 s, doubling with each rate limit in a row (`streak` 1, 2, 3 ...),
// never more than 5 minutes.
export function backoffDelayMs(retryAfter, streak, now = Date.now()) {
  let ms = null;
  const text = retryAfter == null ? "" : String(retryAfter).trim();
  if (/^\d+(\.\d+)?$/.test(text)) ms = Number(text) * 1000;
  else if (text) {
    const at = Date.parse(text);
    if (!Number.isNaN(at)) ms = at - now;
  }
  if (ms == null) ms = BACKOFF_FIRST_MS * 2 ** Math.max(0, (streak || 1) - 1);
  return Math.min(BACKOFF_MAX_MS, Math.max(1000, ms));
}
