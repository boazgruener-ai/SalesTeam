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
  // today - purely informational, added 2026-09-15 per the user's own
  // request ("easier for me to know what I ran today vs. the last 24
  // hours"), local calendar-day (midnight to now), NOT the basis for
  // `level`/the warn/danger threshold below - deliberately left on the
  // rolling last24h window instead, since that's what actually caught the
  // real incident this module exists because of (v0.29.49) and a
  // calendar-day reset would blind the hard-stop to a burst that straddles
  // midnight (e.g. 90 touches at 23:58 + 90 more at 00:05 would show as two
  // separate, smaller-looking days and might never trigger it).
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const today = log.filter((ts) => ts >= todayStart.getTime()).length;
  const level = last24h >= TOUCH_DANGER_THRESHOLD_24H ? "danger" : last24h >= TOUCH_WARN_THRESHOLD_24H ? "warn" : "ok";

  // When room frees up: each touch leaves the rolling window exactly 24h after it happened. After the
  // k oldest active touches have expired, `available` touches are free (whatever is free right now
  // plus those k). Reported at 25 and 50 expired (only if that many are active), earliest first.
  const active = log.filter((ts) => now - ts < 24 * 60 * 60 * 1000).sort((a, b) => a - b);
  const availableNow = Math.max(0, TOUCH_DANGER_THRESHOLD_24H - last24h);
  const release = [25, 50]
    .filter((k) => active.length >= k)
    .map((k) => ({ at: active[k - 1] + 24 * 60 * 60 * 1000, available: availableNow + k }));
  return { last24h, last7d, today, level, availableNow, release };
}

// e.g. "By 22:05 you'll have 32 touches available, by 22:40 57." - empty when nothing is expiring yet.
export function formatTouchRelease(stats) {
  if (!stats.release || stats.release.length === 0) return "";
  const todayStr = new Date().toDateString();
  const fmt = (ms) => {
    const d = new Date(ms);
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === todayStr ? time : `tomorrow ${time}`;
  };
  return stats.release
    .map((r, i) => (i === 0 ? `By ${fmt(r.at)} you'll have ${r.available} touches available` : `by ${fmt(r.at)}, ${r.available}`))
    .join(", ") + ".";
}

// Touches recorded since a moment - the 1.2 pipeline measures its real touches per account with it.
export async function countTouchesSince(sinceMs) {
  const { [TOUCH_LOG_KEY]: log = [] } = await chrome.storage.local.get(TOUCH_LOG_KEY);
  return log.filter((ts) => ts >= sinceMs).length;
}
