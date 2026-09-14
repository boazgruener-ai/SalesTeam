// Rolling log of automated LinkedIn page visits - every scan search, profile
// visit, company-ID resolution, and People Search comparison navigation.
// Kept as a trimmed array of timestamps, not a running total, so the
// visible count is a genuine rolling window (24h / 7d) instead of a
// since-forever counter no one can act on.
//
// Deliberately its own tiny module, not folded into storage.js: every
// module that performs LinkedIn navigations imports this one directly
// (background.js, profile-extraction.js, company-resolve-extraction.js,
// people-search-extraction.js) - including ones that intentionally have no
// dependency on storage.js's lead-results logic (see profile-extraction.js's
// own header comment on why it stays decoupled).
//
// Reported directly (2026-09-10): a single day of concentrated testing (one
// scan, one profile-extraction run, and nine separate company-ID-resolver
// runs spread from 00:54 to 12:23 UTC) triggered LinkedIn's own "unusual
// activity" account warning. Reconstructed after the fact from real
// timestamped data (`linkedinResolveAttemptedAt` on Target Accounts, the
// scan's own reported sub-query total, the profile-extraction completion
// count): ~315 automated page visits in that one day - company resolution
// alone (171) was the single largest contributor, more than the scan and
// profile-extraction combined, and it happened independently across the
// whole day rather than in one obvious burst. This exists to make that
// volume visible BEFORE it happens again, for this user and for anyone else
// running SalesTeam - not to block anything, just to surface what's
// currently invisible.
const TOUCH_LOG_KEY = "linkedinTouchLog";
const RETENTION_MS = 8 * 24 * 60 * 60 * 1000; // a bit over 7 days, so a full trailing week is always available

export async function recordLinkedinTouch() {
  const { [TOUCH_LOG_KEY]: log = [] } = await chrome.storage.local.get(TOUCH_LOG_KEY);
  const now = Date.now();
  const trimmed = log.filter((ts) => now - ts < RETENTION_MS);
  trimmed.push(now);
  await chrome.storage.local.set({ [TOUCH_LOG_KEY]: trimmed }).catch(() => {});
}

// Thresholds set well below the ~315/day that triggered a real LinkedIn
// warning - "warn" gives an early, non-alarming heads-up; "danger" is meant
// to actually give pause before continuing. v0.30.0: raised from 50/100 to
// 75/99 and, per the Target Account/Contact Discovery design, made this ONE
// shared budget govern every automated LinkedIn interaction across the whole
// extension (not a per-feature counter) - LinkedIn itself doesn't care which
// internal feature triggered a request, so nothing here should either. See
// touch-budget-guard.js for the shared enforcement helper built on top of
// this threshold.
export const TOUCH_WARN_THRESHOLD_24H = 75;
export const TOUCH_DANGER_THRESHOLD_24H = 99;

export async function getLinkedinTouchStats() {
  const { [TOUCH_LOG_KEY]: log = [] } = await chrome.storage.local.get(TOUCH_LOG_KEY);
  const now = Date.now();
  const last24h = log.filter((ts) => now - ts < 24 * 60 * 60 * 1000).length;
  const last7d = log.filter((ts) => now - ts < 7 * 24 * 60 * 60 * 1000).length;
  const level = last24h >= TOUCH_DANGER_THRESHOLD_24H ? "danger" : last24h >= TOUCH_WARN_THRESHOLD_24H ? "warn" : "ok";
  return { last24h, last7d, level };
}
