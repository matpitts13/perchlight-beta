// POST /signin {email, beta} -> always 202; GET /s/:token shows a button
// (no state change); POST /s/:token claims the single-use, 30-minute link and
// sets the session cookie (docs/SDD.md, "Routes"). The lookup, rate limits and
// queuing run in waitUntil, so the answer and its timing are the same whether
// or not the address belongs to a tester.
import { clockStub } from "../lib/appctx.js";
import { isToken, sha256Hex, randomId, linkToken } from "../lib/crypto.js";
import { escapeHtml as e, readForm, redirect } from "../lib/http.js";
import { page, message, SIGNIN_SENT_TEXT, SIGNIN_DEAD_TEXT } from "../lib/pages.js";
import { d1Hits, ipHash, HOUR, DAY, MIN } from "../lib/rate.js";
import { verifyTurnstile } from "../lib/turnstile.js";
import { normEmail, emailHmac } from "../lib/testers.js";
import { deliveryStmt } from "../lib/queue.js";
import { sameOrigin, sessionCookie } from "../lib/session.js";

export const SIGNIN_MS = 30 * MIN;

export function signinForm(app, { error = null, ended = false } = {}) {
  const betas = app.cfg.betas.filter((b) => !b.error && b.status !== "draft");
  const body =
    `<h1>Sign in</h1>${ended ? "<p>Your session has ended. Sign in again if you still have access.</p>" : ""}` +
    (error ? `<p class="err">${e(error)}</p>` : "") +
    `<p>We'll email you a link that signs you in.</p><form method="post" action="/signin">` +
    `<label for="beta">Beta</label><select id="beta" name="beta">${betas.map((b) => `<option value="${e(b.id)}">${e(b.name)}</option>`).join("")}</select>` +
    `<label for="email">Email</label><input type="email" id="email" name="email" maxlength="254" required>` +
    `<div class="cf-turnstile" data-sitekey="${e(app.env.TURNSTILE_SITE_KEY ?? "")}" style="margin-top:1rem"></div>` +
    `<button type="submit">Email me a link</button></form>`;
  return page("Sign in", body, error ? 400 : 200, { turnstile: true });
}

function sent(asJson) {
  if (asJson) return new Response('{"ok":true}', { status: 202, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  return message("Check your email", SIGNIN_SENT_TEXT, 202);
}

export async function handleSignin(request, app) {
  const parsed = await readForm(request, 4 * 1024);
  if (parsed.tooBig || parsed.bad) return message("Bad request", "Send the sign-in form.", 400);
  const f = parsed.form;
  const one = (k) => (typeof f.get(k) === "string" ? f.get(k) : "");
  const asJson = parsed.json || /application\/json/.test(request.headers.get("Accept") ?? "");
  const ts = await verifyTurnstile(app.env, one("cf-turnstile-response"), request.headers.get("CF-Connecting-IP"));
  if (!ts.ok) return asJson ? new Response('{"ok":false,"error":"turnstile"}', { status: 400, headers: { "Content-Type": "application/json" } }) : signinForm(app, { error: "Please complete the check and try again." });
  const email = normEmail(one("email"));
  const betaId = one("beta");
  const ip = await ipHash(app, request);
  app.waitUntil(queueSignin(app, email, betaId, ip).catch((err) => console.error(`signin: ${err instanceof Error ? err.message : String(err)}`)));
  return sent(asJson);
}

/** The side effects of POST /signin. Exported for tests. */
export async function queueSignin(app, email, betaId, ip) {
  if (!email || !app.cfg.byId.has(betaId)) return { queued: false };
  const hmac = await emailHmac(app, email);
  const ok = await d1Hits(app, [
    { bucket: `signin:ip:${ip}`, windowMs: HOUR, limit: 20 },
    { bucket: `signin:email:${hmac}`, windowMs: 10 * MIN, limit: 1 },
    { bucket: `signin:email-day:${hmac}`, windowMs: DAY, limit: 5 },
  ]);
  if (!ok) return { queued: false };
  const t = await app.db.prepare("SELECT id, beta_id FROM testers WHERE beta_id = ? AND email_hmac = ? AND status = 'active'").bind(betaId, hmac).first();
  if (!t) return { queued: false };
  const now = app.now;
  const id = randomId("s");
  const hash = await sha256Hex(await linkToken(app.env.LINK_SECRET || "", "signin", id));
  await app.db.batch([
    app.db.prepare("INSERT INTO signins (id, token_hash, tester_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").bind(id, hash, t.id, now, now + SIGNIN_MS),
    deliveryStmt(app.db, { kind: "signin", testerId: t.id, betaId: t.beta_id, ref: id, dedupe: `signin:${id}`, now }),
  ]);
  await clockStub(app.env).wake();
  return { queued: true };
}

async function findSignin(app, token) {
  if (!isToken(token)) return null;
  const hash = await sha256Hex(token);
  const row = await app.db.prepare("SELECT id, tester_id, expires_at, used_at FROM signins WHERE token_hash = ?").bind(hash).first();
  return row && row.used_at === null && row.expires_at > app.now ? { ...row, hash } : null;
}

export async function handleSigninPage(request, app, token) {
  const s = await findSignin(app, token);
  if (!s) return message("Sign in", SIGNIN_DEAD_TEXT, 200);
  return page("Sign in", `<h1>Sign in</h1><form method="post" action="/s/${e(token)}"><button type="submit">Sign in</button></form>`, 200);
}

export async function handleSigninClaim(request, app, token) {
  if (!sameOrigin(app, request)) return message("Forbidden", "This form must be sent from this site.", 403);
  if (!isToken(token)) return message("Sign in", SIGNIN_DEAD_TEXT, 200);
  const hash = await sha256Hex(token);
  const now = app.now;
  const res = await app.db.batch([
    app.db.prepare("UPDATE signins SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING tester_id").bind(now, hash, now),
    app.db.prepare("SELECT t.id, t.beta_id, t.session_ver, t.status FROM signins s JOIN testers t ON t.id = s.tester_id WHERE s.token_hash = ? AND s.used_at = ?").bind(hash, now),
  ]);
  const t = res[1].results[0];
  if (!res[0].results.length || !t || t.status !== "active") return message("Sign in", SIGNIN_DEAD_TEXT, 200);
  return redirect(`/t/${t.beta_id}`, 303, { "Set-Cookie": await sessionCookie(app, t) });
}
