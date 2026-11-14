// Tester sessions: a signed cookie plus session_ver (docs/SDD.md, "Session";
// decision 6). Cookie pb_s = tester_id.session_ver.exp.HMAC(SESSION_SECRET, …),
// HttpOnly; Secure; SameSite=Lax; Path=/, 30 days. One D1 read per request,
// no writes except last_seen_day at most once a day. State-changing POSTs check
// Origin against PUBLIC_URL and need a per-session CSRF value.
import { sign, verify, hmacHex, safeEqual } from "./crypto.js";
import { utcDay } from "./http.js";

export const COOKIE = "pb_s";
export const SESSION_MS = 30 * 86_400_000;

function secret(app) {
  return app.env.SESSION_SECRET || "";
}

export async function sessionCookie(app, tester) {
  const exp = app.now + SESSION_MS;
  const body = `${tester.id}.${tester.session_ver}.${exp}`;
  const value = `${body}.${await sign(secret(app), `session/${body}`)}`;
  return `${COOKIE}=${value}; Max-Age=${SESSION_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie() {
  return `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(request) {
  const h = request.headers.get("Cookie") ?? "";
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

/** The cookie's claims if its signature and expiry hold (no D1 read). */
export async function parseCookie(app, request) {
  const v = readCookie(request);
  if (!v || v.length > 200 || !secret(app)) return null;
  const m = /^(t_[a-z0-9]{16})\.(\d{1,9})\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(v);
  if (!m) return null;
  const body = `${m[1]}.${m[2]}.${m[3]}`;
  if (!(await verify(secret(app), `session/${body}`, m[4]))) return null;
  if (Number(m[3]) <= app.now) return null;
  return { id: m[1], ver: Number(m[2]) };
}

export const TESTER_COLS =
  "t.id, t.beta_id, t.email, t.email_hmac, t.name, t.status, t.session_ver, t.terms_accepted_version, t.reader_code, t.groups, t.reminders_off, t.last_seen_day, t.key_status, t.license_id, b.closed_at";

/**
 * The signed-in tester (status active, session_ver current), or { tester: null, why }.
 * why: "none" (no valid cookie) | "ended" (revoked, withdrawn, deleted or signed out elsewhere).
 */
export async function loadSession(app, request) {
  const c = await parseCookie(app, request);
  if (!c) return { tester: null, why: "none" };
  const t = await app.db.prepare(`SELECT ${TESTER_COLS} FROM testers t LEFT JOIN betas b ON b.id = t.beta_id WHERE t.id = ?`).bind(c.id).first();
  if (!t || t.session_ver !== c.ver || t.status !== "active") return { tester: null, why: "ended" };
  const day = utcDay(app.now);
  if (t.last_seen_day !== day) {
    app.waitUntil(app.db.prepare("UPDATE testers SET last_seen_day = ? WHERE id = ?").bind(day, t.id).run().catch(() => {}));
  }
  return { tester: t };
}

export async function csrfFor(app, scope) {
  return (await hmacHex(secret(app), `csrf/${scope}`)).slice(0, 32);
}

export function testerScope(t) {
  return `${t.id}/${t.session_ver}`;
}

export async function checkCsrf(app, scope, value) {
  if (typeof value !== "string" || value.length !== 32) return false;
  return safeEqual(await csrfFor(app, scope), value);
}

/** A state-changing request must come from this deployment's own pages. */
export function sameOrigin(app, request) {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try {
    return origin === new URL(app.base).origin;
  } catch {
    return false;
  }
}
