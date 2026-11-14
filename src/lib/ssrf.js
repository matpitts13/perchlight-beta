// Rules for every outgoing URL: job targets, forwards, replays and alert
// webhooks (docs/SDD.md, "SSRF and outgoing URLs"). They are only ever set by
// you, never taken from a captured request, and still checked when set and
// before every send, including each redirect hop.
//
// What this can't check: a public hostname that resolves to a private
// address. A Worker's fetch() runs on Cloudflare's network and can't reach
// your home or office network; these rules stop mistakes and obvious misuse.
//
// The WHATWG URL parser already normalises decimal, hex, octal and short IPv4
// forms (http://2130706433/, http://0x7f.1/, http://0177.0.0.1/) to dotted
// decimal and compresses IPv6, so the checks below see canonical addresses.

const V4_BLOCKED = [
  ["0.0.0.0", 8, "unspecified"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "CGNAT"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "IETF protocol assignments"],
  ["192.0.2.0", 24, "documentation"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
];

function v4ToInt(s) {
  const p = s.split(".");
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  return p.reduce((n, x) => n * 256 + Number(x), 0);
}

/** Why an IPv4 address is refused, or null. */
export function blockedV4(s) {
  const n = typeof s === "number" ? s : v4ToInt(s);
  if (n === null) return null;
  for (const [base, bits, why] of V4_BLOCKED) {
    const b = v4ToInt(base);
    const size = 2 ** (32 - bits);
    if (n >= b && n < b + size) return why;
  }
  return null;
}

/** 8 groups of 16 bits, or null. */
function v6Groups(s) {
  let str = s.toLowerCase();
  // an embedded dotted IPv4 tail
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(str);
  if (m) {
    const n = v4ToInt(m[2]);
    if (n === null) return null;
    str = `${m[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const g = [...head, ...Array(fill).fill("0"), ...tail];
  if (g.length !== 8 || g.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return g.map((x) => parseInt(x, 16));
}

/** Why an IPv6 address is refused, or null. */
export function blockedV6(s) {
  const g = v6Groups(s);
  if (!g) return "not a valid IPv6 address";
  const zero = (from, to) => g.slice(from, to).every((x) => x === 0);
  const v4 = (g[6] << 16) + g[7];
  const embedded = () => blockedV4(v4 >>> 0);
  if (zero(0, 8)) return "unspecified";
  if (zero(0, 7) && g[7] === 1) return "loopback";
  if (zero(0, 5) && g[5] === 0xffff) return embedded() ? `IPv4-mapped ${embedded()}` : null;
  if (zero(0, 6)) return embedded() ? `IPv4-compatible ${embedded()}` : null;
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return embedded() ? `NAT64 ${embedded()}` : null;
  if ((g[0] & 0xfe00) === 0xfc00) return "unique local (private)";
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local";
  if ((g[0] & 0xff00) === 0xff00) return "multicast";
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "documentation";
  return null;
}

const BLOCKED_NAMES = /(^|\.)(localhost|local|internal|home\.arpa|localdomain)$/i;
const LOCAL_DEV = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** Whether this deployment is itself local (PUBLIC_URL on localhost) and opted in to local targets. */
export function localTargetsAllowed(env) {
  if (String(env?.ALLOW_LOCAL_TARGETS ?? "") !== "1") return false;
  try {
    return LOCAL_DEV.test(new URL(String(env.PUBLIC_URL ?? "")).hostname);
  } catch {
    return false;
  }
}

/**
 * Checks an outgoing URL.
 * @param {string} raw
 * @param {{ allowHttp?: boolean, ownHost?: string | null, allowLocal?: boolean }} opts
 * @returns {{ ok: true, url: URL } | { ok: false, error: string }}
 */
export function checkTarget(raw, { allowHttp = false, ownHost = null, allowLocal = false } = {}) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return { ok: false, error: "isn't a valid URL" };
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && (allowHttp || allowLocal))) {
    return { ok: false, error: u.protocol === "http:" ? "must use https: (set allowHttp: true to allow http:)" : `the ${u.protocol} scheme isn't allowed` };
  }
  if (u.username || u.password) return { ok: false, error: "mustn't contain a user name or password (use a secret header instead)" };
  // A trailing dot ("localhost.") names the same host.
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (ownHost && host === String(ownHost).toLowerCase().replace(/:\d+$/, "") && /^\/(h|p)\//.test(u.pathname)) {
    return { ok: false, error: "points at this deployment's own capture or ping URLs (a loop)" };
  }
  if (allowLocal && LOCAL_DEV.test(host)) return { ok: true, url: u };
  if (host.startsWith("[")) {
    const why = blockedV6(host.slice(1, -1));
    if (why) return { ok: false, error: `points at a ${why} address` };
    return { ok: true, url: u };
  }
  if (/^[\d.]+$/.test(host)) {
    const why = blockedV4(host);
    if (why) return { ok: false, error: `points at a ${why} address` };
    if (v4ToInt(host) === null) return { ok: false, error: "isn't a valid IPv4 address" };
    return { ok: true, url: u };
  }
  if (BLOCKED_NAMES.test(host)) return { ok: false, error: `points at a local name (${host})` };
  if (!host.includes(".")) return { ok: false, error: `"${host}" is a single-label name (only public host names are allowed)` };
  return { ok: true, url: u };
}

/** The host only, for display and history (never the path or query, which can hold secrets). */
export function hostOf(raw) {
  try {
    return new URL(String(raw)).host;
  } catch {
    return "";
  }
}
