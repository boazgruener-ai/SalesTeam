// When are two contacts at one account the same person? (contact deduplication, 2026-10-10)
//
// Found in the first real Salesforce import: about 10 people were in SalesTeam twice at the same account - once from
// the research workbook and once found again by web research - because contacts were told apart by their exact name
// (contactKeyFor). "Dr. Hansjoerg Rodi" / "Hansjoerg Rodi", "Özlem" / "Oezlem Civelek", "Keelan I. Adamson" /
// "Keelan Adamson", "Weng Kuan (WK) Tan" / "Weng Kuan Tan". Two at one account are the same person when
//   - their LinkedIn profiles are the same (a trailing "/" or "?…" ignored), or
//   - their first and last names are the same once titles (Dr., Prof. …), initials, nicknames in brackets and middle
//     names are left out, ä/ö/ü written either way (ö = oe = o), hyphens ignored (Hans-Jörg = Hansjörg) -
//     unless both have a LinkedIn profile and the profiles differ: then they are two people who share a name.
//
//   linkedinProfileSlug(url)          -> "oezlemcivelek" or null (only a linkedin.com/in/ link is a profile)
//   samePerson(a, b)                  -> true / false   (a, b: { fullName, lastVerified2 } at the same account)
//   createPersonIndex()               -> { add(companyKey, person, value), find(companyKey, person) -> value | null }
//   contactDuplicatePairs(contacts, opts) -> [[a, b], …]  the pairs already stored (for Decisions)
//
// PURE - no chrome APIs, no storage, no DOM (test_pure_modules.py runs it).

import { normalizeCompanyName } from "./company-identity.js";

// Words that are not a name: academic and professional titles, salutations, suffixes.
const NOT_A_NAME = new Set([
  "dr", "prof", "professor", "med", "phd", "dphil", "mba", "emba", "msc", "bsc", "llm", "lic", "iur", "oec",
  "rer", "nat", "pol", "dipl", "ing", "pd", "habil", "mr", "mrs", "ms", "sir", "jr", "sr", "ii", "iii", "cfa", "cpa",
  "fca", "eur", "hsg", "eth", "hc",
]);

export function linkedinProfileSlug(url) {
  const m = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(String(url || ""));
  if (!m) return null;
  let slug = m[1];
  try { slug = decodeURIComponent(slug); } catch { /* keep as written */ }
  return slug.toLowerCase() || null;
}

// Accents off. Spelled out for the common letters as well as normalize("NFD"), which a JavaScript engine without
// Unicode data (the test harness) leaves as it is.
const ACCENT_FOLD = { a: "àáâãäåāăą", c: "çćč", d: "ď", e: "èéêëēėęě", i: "ìíîïīį", l: "ł", n: "ñńň", o: "òóôõöøōő", r: "ŕř", s: "śšş",
  t: "ť", u: "ùúûüūůűų", y: "ýÿ", z: "žźż" };
const PLAIN_OF = new Map(Object.entries(ACCENT_FOLD).flatMap(([plain, accented]) => [...accented].map((c) => [c, plain])));
const stripMarks = (s) => [...s.normalize("NFD").replace(/[̀-ͯ]/g, "")].map((c) => PLAIN_OF.get(c) || c).join("");
// German umlauts written out: Özlem -> oezlem, Schäfer -> schaefer, Strauß -> strauss.
const umlautsWritten = (s) => stripMarks(s.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss"));

// The name words that count: lower case, brackets and titles out, hyphens and apostrophes joined, initials out.
export function personNameWords(fullName) {
  return String(fullName || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")           // "Weng Kuan (WK) Tan"
    .replace(/[-'’]/g, "")                // "Hans-Jörg", "D'Amico"
    .split(/[^0-9a-zÀ-ɏͰ-ϿЀ-ӿ]+/) // the letters of Latin, Greek and Cyrillic names
    .filter((w) => w && !NOT_A_NAME.has(stripMarks(w)) && stripMarks(w).length > 1);
}

// Each spelling a word may have been written in: "özlem" -> ["ozlem", "oezlem"].
function spellings(word) {
  return [...new Set([stripMarks(word), umlautsWritten(word)])];
}

// The keys a name is found under: first word x last word, every spelling of each. Fewer than two words -> none (a
// single name is matched by LinkedIn profile only).
function nameKeys(fullName) {
  const words = personNameWords(fullName);
  if (words.length < 2) return [];
  const keys = [];
  for (const f of spellings(words[0])) for (const l of spellings(words[words.length - 1])) keys.push(`${f} ${l}`);
  return keys;
}

const slugOf = (p) => linkedinProfileSlug(p && (p.lastVerified2 || p.linkedinUrl || p.linkedinProfileUrl));

export function samePerson(a, b) {
  const sa = slugOf(a);
  const sb = slugOf(b);
  if (sa && sb) return sa === sb;
  const kb = new Set(nameKeys(b && b.fullName));
  return nameKeys(a && a.fullName).some((k) => kb.has(k));
}

// An index of the people already known, per account (companyKey = normalizeCompanyName of the account name). add()
// stores a value (the row, its extras key …) that find() returns for the same person.
export function createPersonIndex() {
  const bySlug = new Map();
  const byName = new Map(); // "company|first last" -> [{ slug, value }]
  return {
    add(companyKey, person, value) {
      const ck = normalizeCompanyName(companyKey);
      if (!ck || !person) return;
      const slug = slugOf(person);
      if (slug && !bySlug.has(`${ck}|${slug}`)) bySlug.set(`${ck}|${slug}`, value);
      for (const k of nameKeys(person.fullName)) {
        const list = byName.get(`${ck}|${k}`) || [];
        list.push({ slug, value });
        byName.set(`${ck}|${k}`, list);
      }
    },
    find(companyKey, person) {
      const ck = normalizeCompanyName(companyKey);
      if (!ck || !person) return null;
      const slug = slugOf(person);
      if (slug && bySlug.has(`${ck}|${slug}`)) return bySlug.get(`${ck}|${slug}`);
      for (const k of nameKeys(person.fullName)) {
        // A namesake with a different LinkedIn profile is someone else.
        const hit = (byName.get(`${ck}|${k}`) || []).find((e) => !slug || !e.slug || e.slug === slug);
        if (hit) return hit.value;
      }
      return null;
    },
  };
}

// The pairs of stored contacts that are the same person. contacts: [{ company, fullName, lastVerified2, key, … }] -
// the live ones only (the caller leaves out deleted contacts). opts.keptApart: Set of "keyA|keyB" (sorted) the user
// answered "Keep both" for. Each contact appears in at most one pair; a third copy shows up once the first pair is
// settled.
export function contactDuplicatePairs(contacts, opts = {}) {
  const keptApart = opts.keptApart || new Set();
  const byCompany = new Map();
  for (const c of contacts || []) {
    const ck = normalizeCompanyName(c && c.company);
    if (!ck || !c.fullName) continue;
    if (!byCompany.has(ck)) byCompany.set(ck, []);
    byCompany.get(ck).push(c);
  }
  const pairs = [];
  for (const list of byCompany.values()) {
    const used = new Set();
    for (let i = 0; i < list.length; i++) {
      if (used.has(i)) continue;
      for (let j = i + 1; j < list.length; j++) {
        if (used.has(j)) continue;
        if (list[i].key && list[i].key === list[j].key) continue; // the very same entry twice in the sheet
        if (keptApart.has(contactPairKey(list[i].key, list[j].key))) continue;
        if (!samePerson(list[i], list[j])) continue;
        pairs.push([list[i], list[j]]);
        used.add(i); used.add(j);
        break;
      }
    }
  }
  return pairs;
}

export function contactPairKey(a, b) {
  return [String(a || ""), String(b || "")].sort().join("|");
}

// Which of two entries for one person to keep on Merge: the fuller one - a LinkedIn profile counts most, then each
// filled detail; on a tie the one not found by web research (the researched row came first).
const DETAIL_FIELDS = ["jobTitle", "publicBusinessEmail", "publicBusinessPhone", "profileUrl", "city", "country", "function"];
export function fullerFirst(a, b) {
  const score = (c) => (slugOf(c) ? 3 : 0) + DETAIL_FIELDS.filter((f) => c[f] != null && String(c[f]).trim() !== "").length + (c.source === "Web" ? 0 : 0.5);
  return score(b) > score(a) ? [b, a] : [a, b];
}
