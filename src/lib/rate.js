// Rate limits (docs/SDD.md, "Security"). Copied from perchlight-keys
// src/lib/rate.js: D1 `rate` rows (limits that must hold across isolates) and
// isolate-memory windows (cheap floods). IP addresses are never stored: the IP
// hash is HMAC(daily salt, ip), the daily salt being HMAC(IP_SALT, day); rows
// are kept 48 hours.
import { hmacHex } from "./crypto.js";
import { utcDay } from "./http.js";

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

const MAX_KEYS = 5000;
let windows = new Map();

export function resetRate() {
  windows = new Map();
}

/** true if allowed. Fixed windows in isolate memory. */
export function memoryHit(key, limit, now, windowMs = MIN) {
  const start = Math.floor(now / windowMs) * windowMs;
  const w = windows.get(key);
  if (!w || w.start !== start) {
    if (windows.size >= MAX_KEYS) {
      for (const [k, v] of windows) if (v.start + v.ms <= now) windows.delete(k);
      if (windows.size >= MAX_KEYS) windows = new Map();
    }
    windows.set(key, { start, n: 1, ms: windowMs });
    return true;
  }
  w.n++;
  return w.n <= limit;
}

export async function ipHash(app, request) {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const daily = await hmacHex(app.env.IP_SALT || "perchlight-beta", `ip-salt/${utcDay(app.now)}`);
  return (await hmacHex(daily, ip)).slice(0, 32);
}

/** Statements that count one hit in each bucket. buckets: [{ bucket, windowMs }]. */
export function rateStmts(app, buckets) {
  const now = app.now;
  return buckets.map(({ bucket, windowMs }) => {
    const start = Math.floor(now / windowMs) * windowMs;
    return app.db
      .prepare("INSERT INTO rate (bucket, window_start, count, expires_at) VALUES (?, ?, 1, ?) ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1 RETURNING count")
      .bind(bucket, start, Math.max(start + windowMs, now + 48 * HOUR));
  });
}

/** Counts one hit in every bucket (one batch); true when all are within their limits. */
export async function d1Hits(app, buckets) {
  const res = await app.db.batch(rateStmts(app, buckets));
  return buckets.every((b, i) => (res[i].results[0]?.count ?? Infinity) <= b.limit);
}
