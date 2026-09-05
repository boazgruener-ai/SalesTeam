// Relevance scoring for merging results across multiple topic searches.
// Priority order: (1) posts matching more topics rank higher, (2) posts that
// ranked higher within their own topic's search rank higher, (3) newer posts
// rank higher. LinkedIn only exposes relative timestamps ("2h", "3d", "1w"),
// so recency is approximate, not exact.

function approxHoursAgo(timestampText) {
  if (!timestampText) return Number.MAX_SAFE_INTEGER;
  const match = timestampText.trim().match(/^(\d+)\s*(min|h|d|w|mo|yr)/i);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const hoursPerUnit = { min: 1 / 60, h: 1, d: 24, w: 24 * 7, mo: 24 * 30, yr: 24 * 365 };
  return value * (hoursPerUnit[unit] ?? Number.MAX_SAFE_INTEGER);
}

export function scoreResult(result) {
  const topicsMatchedCount = result.matchedTopics.length;
  const avgRank =
    result.matchedTopics.reduce((sum, t) => sum + (t.rank ?? 0), 0) / topicsMatchedCount;
  // Post leads store this as timestampText ("16h"); job leads as postedText
  // ("16 hours ago") - the regex below happens to parse both formats fine.
  const hoursAgo = approxHoursAgo(result.timestampText || result.postedText);

  return topicsMatchedCount * 100000 - avgRank * 10 - hoursAgo;
}

export function sortResultsByRelevance(resultsMap) {
  return Object.values(resultsMap).sort((a, b) => scoreResult(b) - scoreResult(a));
}
