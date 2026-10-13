// Billing "Team usage" (BILLING_TEAM_USAGE_DESIGN.md 4, D1): a member's monthly totals lie in the team folder
// encrypted for the Team Lead and the deputy, so a colleague who opens the file sees no figures.
//
// Every member's browser has one key pair (RSA-OAEP). The private key cannot be exported and stays in this
// browser's IndexedDB; the public key is written to the team folder. The totals are encrypted once with a fresh
// content key (AES-GCM), and that key is wrapped for each reader with their public key.
//
// This is protection against a colleague who looks, not against one who attacks: the folder is writable by every
// member, so a public key file could be replaced. Say "encrypted for the Team Lead and the deputy", never "secure".
//
// Web Crypto only - test_team_sync.py replaces this file with a stub, as it does team-folder.js.

const RSA = { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

function toBase64(buffer) {
  let s = "";
  for (const b of new Uint8Array(buffer)) s += String.fromCharCode(b);
  return btoa(s);
}
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

// -> { privateKey (a CryptoKey - IndexedDB stores it as it is), publicJwk }
export async function makeUsageKeyPair() {
  const pair = await crypto.subtle.generateKey(RSA, false, ["encrypt", "decrypt"]);
  return { privateKey: pair.privateKey, publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey) };
}

// What tells one public key from another (the file is rewritten when a reader's key changes).
export const usageKeyId = (publicJwk) => String(publicJwk?.n || "");

// readers: { memberId: publicJwk }. -> { iv, data, keys: { memberId: wrapped content key } }
export async function sealUsage(value, readers) {
  const contentKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, contentKey, new TextEncoder().encode(JSON.stringify(value)));
  const raw = await crypto.subtle.exportKey("raw", contentKey);
  const keys = {};
  for (const [member, jwk] of Object.entries(readers || {})) {
    try {
      const pub = await crypto.subtle.importKey("jwk", jwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
      keys[member] = toBase64(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pub, raw));
    } catch { /* a key file that is not a key: that reader is left out, the others still get theirs */ }
  }
  return { iv: toBase64(iv), data: toBase64(data), keys };
}

// The value sealed for `member`, or null when it was not sealed for this key (or is not readable at all).
export async function openUsage(sealed, member, privateKey) {
  try {
    const wrapped = sealed?.keys?.[member];
    if (!wrapped || !privateKey) return null;
    const raw = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, fromBase64(wrapped));
    const contentKey = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(sealed.iv) }, contentKey, fromBase64(sealed.data));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}
