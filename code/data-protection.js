// 1.2.4.12 Data protection (DATA_PROTECTION_REQUIREMENTS.md R2, R6): what a permanent delete leaves behind.
// PURE - no chrome.*, no DOM - so test_pure_modules.py and test_team_sync.py run it for real.
//
// A permanent delete in a team goes out as an "erase" record that names its row only by a hash: the record has to stay
// in the team folder for good (so an old change read later cannot bring the row back), and a row id can hold a name
// ("acme ag::ann muster"). SHA-256, written out here because crypto.subtle is async and the merge is not.

import { normalizeCompanyName } from "./company-identity.js";
import { linkedinProfileSlug, nameKeys } from "./person-identity.js";

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function utf8(str) {
  const out = [];
  for (const ch of String(str)) {
    let c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

export function sha256Hex(str) {
  const bytes = utf8(str);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000);
  for (const v of [hi, bitLen >>> 0]) bytes.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return [...h].map((v) => v.toString(16).padStart(8, "0")).join("");
}

// The name an erased row goes by in the team folder: 32 hex digits, the same on every PC.
const eraseCache = new Map();
export function eraseHash(e, id) {
  const k = `${e}|${id}`;
  let h = eraseCache.get(k);
  if (!h) {
    h = sha256Hex(`salesteam-erase|${k}`).slice(0, 32);
    if (eraseCache.size > 50000) eraseCache.clear();
    eraseCache.set(k, h);
  }
  return h;
}

// --------------------------------------------------------------------------
// What else names a deleted lead or contact: activity-log and team-log lines (both kept on this PC only)
// --------------------------------------------------------------------------
// match: { keys: [lead keys, contact keys, row ids], names: [person names] }. A log line goes when it carries one of
// the keys, or names the person. Only a name of two words or more counts: one word ("Microsoft", a company page's post)
// would match far too much.
export function logMatcher({ keys = [], names = [] } = {}) {
  const ks = [...new Set(keys.filter((k) => typeof k === "string" && k))];
  const ns = [...new Set(names.filter((n) => typeof n === "string").map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 4 && n.includes(" ")))];
  if (!ks.length && !ns.length) return () => false;
  return (entry) => {
    if (!entry || typeof entry !== "object") return false;
    if (ks.includes(entry.relatedContactKey)) return true;
    const text = JSON.stringify(entry);
    if (ks.some((k) => text.includes(JSON.stringify(k).slice(1, -1)))) return true;
    const lower = text.toLowerCase();
    return ns.some((n) => lower.includes(n));
  };
}

// The local key holding rows deleted permanently that the team sync still has to send as erase records
// (DATA_PROTECTION_REQUIREMENTS.md R6.1): [{ rk: "<e>|<id>", at }]. Personal - never shared itself.
export const TEAM_PENDING_ERASURES_KEY = "teamPendingErasures";

// --------------------------------------------------------------------------
// The do-not-store list (1.2.4.20, DATA_PROTECTION_REQUIREMENTS.md R3-R4)
// --------------------------------------------------------------------------
// A person who asked to be forgotten, or was deleted permanently, is not stored again: whatever brings people in
// (scans, contact discovery, web research, imports) skips them. The list holds hashes only, never the name or the link
// (R4.1):
//   person: { k: "person", p: <profile hash> | null, n: [<name|company hashes>], a: [<name hashes>], at, by }
//           n blocks the person at that company, every way the name may be written (person-identity.js nameKeys);
//           a is only for "Allow this person again" by name, where no company is asked - it blocks nothing.
//   post:   { k: "post", h: <post hash>, at, by } - a deleted lead's post, so a later scan skips it (R4.6); its
//           author is not blocked.
// One object keyed by entry id. In a team it is shared row by row and only the Team Lead or deputy writes it
// (team-merge.js GATED_PREFIXES), so no colleague's edit ever brings an entry back (R4.3).
export const DO_NOT_STORE_KEY = "doNotStore";

const hashCache = new Map();
function tagHash(tag, text) {
  const k = `${tag}|${text}`;
  let h = hashCache.get(k);
  if (!h) {
    h = sha256Hex(`salesteam-dns|${k}`).slice(0, 32);
    if (hashCache.size > 50000) hashCache.clear();
    hashCache.set(k, h);
  }
  return h;
}

// A LinkedIn profile link -> its hash, or null (only a linkedin.com/in/ link is a profile).
export function profileHash(url) {
  const slug = linkedinProfileSlug(url || "");
  return slug ? tagHash("p", slug) : null;
}

export function nameCompanyHashes(fullName, company) {
  const ck = normalizeCompanyName(company || "");
  if (!ck) return [];
  return nameKeys(fullName).map((k) => tagHash("n", `${ck}|${k}`));
}

export function nameOnlyHashes(fullName) {
  return nameKeys(fullName).map((k) => tagHash("a", k));
}

export function postHash(leadKey) {
  return leadKey ? tagHash("post", String(leadKey)) : null;
}

// The profile link a stored person carries: a contact's lastVerified2 (or an import's linkedinUrl), a lead's profileUrl.
export const personProfileUrl = (x) => (x && (x.lastVerified2 || x.linkedinUrl || x.linkedinProfileUrl || x.profileUrl)) || null;

// person: { fullName, company, profileUrl } -> { id, entry } or null (nothing to recognise them by).
export function personEntry(person, by, at) {
  const p = profileHash(person.profileUrl);
  const n = nameCompanyHashes(person.fullName, person.company);
  if (!p && !n.length) return null;
  return { id: `p-${p || n[0]}`, entry: { k: "person", p, n, a: nameOnlyHashes(person.fullName), at, by: by || null } };
}

export function postEntry(leadKey, by, at) {
  const h = postHash(leadKey);
  return h ? { id: `post-${h}`, entry: { k: "post", h, at, by: by || null } } : null;
}

export const isPersonEntry = (x) => Boolean(x && x.k === "person");
export const countBlockedPeople = (list) => Object.values(list || {}).filter(isPersonEntry).length;

// list -> { empty, person(q), post(key), lead(lead) }. q: { fullName, company, profileUrl }. lead() answers "person"
// (its author is on the list), "post" (the post was deleted) or null.
export function doNotStoreMatcher(list) {
  const p = new Set();
  const n = new Set();
  const posts = new Set();
  for (const x of Object.values(list || {})) {
    if (!x || typeof x !== "object") continue;
    if (x.k === "post" && x.h) posts.add(x.h);
    if (x.k !== "person") continue;
    if (x.p) p.add(x.p);
    for (const h of x.n || []) n.add(h);
  }
  const empty = !p.size && !n.size && !posts.size;
  const person = (q) => {
    if (empty || !q) return false;
    const ph = p.size ? profileHash(q.profileUrl) : null;
    if (ph && p.has(ph)) return true;
    return n.size > 0 && nameCompanyHashes(q.fullName, q.company).some((h) => n.has(h));
  };
  const post = (key) => posts.size > 0 && posts.has(postHash(key));
  const lead = (l, key = l?.key) => {
    if (empty || !l) return null;
    if (post(key)) return "post";
    if (l.author && person({ fullName: l.author, company: l.company, profileUrl: l.profileUrl })) return "person";
    return null;
  };
  return { empty, person, post, lead };
}

// What the user typed in "Find a person": a LinkedIn profile link, or a name of two words or more.
// -> { ok: true, slug } | { ok: true, name, keys } | { ok: false, reason: "empty" | "link" | "short" }
export function personQuery(input) {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, reason: "empty" };
  if (/linkedin\.com|^https?:|^www\./i.test(raw)) {
    const slug = linkedinProfileSlug(raw);
    return slug ? { ok: true, slug } : { ok: false, reason: "link" };
  }
  const keys = nameKeys(raw);
  return keys.length ? { ok: true, name: raw, keys } : { ok: false, reason: "short" };
}

// Is this stored person ({ fullName | author | name, profile link }) the one asked for? A link finds by profile; a
// name by first and last name, every spelling - but not a namesake whose profile differs from the one asked for.
export function queryFinds(q, person) {
  if (!q || !q.ok || !person) return false;
  const slug = linkedinProfileSlug(personProfileUrl(person) || "");
  if (q.slug) return slug === q.slug;
  const keys = new Set(q.keys);
  return nameKeys(person.fullName || person.author || person.name).some((k) => keys.has(k));
}

// "Allow this person again" (R4.5): the ids of the entries the same link or name finds. A link finds by profile; a
// name by name at any company (namesakes too - the page says how many).
export function entriesToAllow(list, input) {
  const q = personQuery(input);
  if (!q.ok) return [];
  const ph = q.slug ? tagHash("p", q.slug) : null;
  const as = new Set(q.slug ? [] : q.keys.map((k) => tagHash("a", k)));
  return Object.entries(list || {})
    .filter(([, x]) => isPersonEntry(x) && (ph ? x.p === ph : (x.a || []).some((h) => as.has(h))))
    .map(([id]) => id);
}

// Does a text (a note, a conversation) name one of `names`? Only a name of two words or more counts, any case.
export function textNames(text, names) {
  const lower = String(text || "").toLowerCase();
  if (!lower) return false;
  return (names || []).some((nm) => {
    const n = String(nm || "").trim().toLowerCase();
    return n.length >= 4 && n.includes(" ") && lower.includes(n);
  });
}
