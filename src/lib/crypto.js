// Hashes, HMAC, tokens and constant-time comparison.
// From perchlight-hooks src/lib/crypto.js (hex, sha256Hex, hmacHex, safeEqual,
// sortableId), plus base64url HMAC signing and verification with
// crypto.subtle.verify (constant time) for download links and session cookies.

const enc = new TextEncoder();

export function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function toB64url(bytes) {
  let bin = "";
  const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const t = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  try {
    const bin = atob(t);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function sha256Hex(data) {
  return hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
}

const keyCache = new Map();
async function hmacKeyFor(secret) {
  let k = keyCache.get(secret);
  if (!k) {
    k = await crypto.subtle.importKey("raw", enc.encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    if (keyCache.size > 20) keyCache.clear();
    keyCache.set(secret, k);
  }
  return k;
}

export async function hmacHex(secret, message) {
  return hex(await crypto.subtle.sign("HMAC", await hmacKeyFor(secret), enc.encode(String(message))));
}

/** HMAC-SHA256, base64url (43 characters). */
export async function sign(secret, message) {
  return toB64url(await crypto.subtle.sign("HMAC", await hmacKeyFor(secret), enc.encode(String(message))));
}

/** Constant-time check of a base64url HMAC (crypto.subtle.verify). */
export async function verify(secret, message, sig) {
  const bytes = fromB64url(sig);
  if (!bytes || bytes.length !== 32) return false;
  return crypto.subtle.verify("HMAC", await hmacKeyFor(secret), bytes, enc.encode(String(message)));
}

/** Constant-time comparison of two strings (hashes both first, so lengths don't leak either). */
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(String(a))), crypto.subtle.digest("SHA-256", enc.encode(String(b)))]);
  return crypto.subtle.timingSafeEqual(x, y);
}

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // 32 symbols: no 0/o, 1/l

/** "<prefix>_" + 16 random characters (80 bits): an id, not a secret. */
export function randomId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += ALPHABET[b & 31];
  return `${prefix}_${s}`;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** A reader code: 8 Crockford base32 characters (40 bits), shown as XXXX-XXXX. */
export function readerCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const b of bytes) s += CROCKFORD[b & 31];
  return s;
}

/**
 * An invite or sign-in token: 128 bits, 22 base64url characters, derived as
 * HMAC(LINK_SECRET, kind/id) from a random row id. Deriving it (rather than
 * keeping it) means only its SHA-256 is stored, and a retried send carries the
 * same link under the same Resend idempotency key.
 */
export async function linkToken(secret, kind, id) {
  const mac = await crypto.subtle.sign("HMAC", await hmacKeyFor(secret), enc.encode(`${kind}/${id}`));
  return toB64url(new Uint8Array(mac).slice(0, 16));
}

export const isToken = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{22}$/.test(s);

let lastMs = 0;
let seq = 0;
/** A time-sortable id (from perchlight-hooks). */
export function sortableId(prefix, now = Date.now()) {
  const ms = Math.floor(now);
  seq = ms === lastMs ? seq + 1 : 0;
  lastMs = ms;
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let r = "";
  for (const b of bytes) r += ALPHABET[b & 31];
  return `${prefix}${ms.toString(36).padStart(9, "0")}${Math.min(seq, 46655).toString(36).padStart(3, "0")}${r}`;
}
