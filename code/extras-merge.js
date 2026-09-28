// Applies only what a writer actually changed (1.2.1 build step 0, ONBOARDING_RESEARCH_DESIGN.md 2.2). Pure - no
// chrome.*, no DOM - so test_pure_modules.py runs it for real.
// The account page, the findings review and research's automatic fill all take a copy of an account's `overrides`
// (or `webFindingsDismissed`), change a few keys, and used to write the WHOLE copy back. Anything another writer
// changed on that account in between - research filling an empty field while the edit form was open - was put back
// to the old copy. The write lock cannot help: each write is whole, but it writes stale values. Instead the writer
// passes the copy it started from (`base`), and only the keys that differ between `base` and `edited` are applied
// onto what is stored `current`ly. The same key changed on both sides: this writer wins (it is the later one).

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function mergeFieldChanges(base, edited, current) {
  const from = base || {};
  const to = edited || {};
  const out = { ...(current || {}) };
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  for (const k of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (has(to, k)) {
      if (!has(from, k) || !sameValue(from[k], to[k])) out[k] = to[k];
    } else if (has(from, k)) {
      delete out[k]; // removed by this writer (e.g. a field set back to its imported value)
    }
  }
  return out;
}
