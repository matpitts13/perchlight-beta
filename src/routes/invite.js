// GET /i/:token (shows the page, changes nothing: mail scanners open links)
// and POST /i/:token/claim (claim-then-act, docs/SDD.md "Invites and
// claim-then-act"). The claim is one D1 batch whose first statement is the
// conditional UPDATE … RETURNING; every later statement is guarded by the
// claim_id that only the winning claim wrote, so if the claim updates no
// rows, nothing else in the batch does anything.
import { betaState } from "../lib/betas.js";
import { termsSha, clockStub } from "../lib/appctx.js";
import { isToken, sha256Hex, randomId } from "../lib/crypto.js";
import { escapeHtml as e, readForm, redirect } from "../lib/http.js";
import { page, message, inviteDeadPage, errorList } from "../lib/pages.js";
import { d1Hits, ipHash, HOUR } from "../lib/rate.js";
import { csrfFor, checkCsrf, sameOrigin, sessionCookie, parseCookie } from "../lib/session.js";
import { PRIORITY } from "../lib/queue.js";

async function lookup(app, token) {
  if (!isToken(token)) return null;
  const hash = await sha256Hex(token);
  const row = await app.db
    .prepare("SELECT i.id, i.status, i.expires_at, i.tester_id, t.beta_id, t.name, t.status AS tester_status FROM invites i JOIN testers t ON t.id = i.tester_id WHERE i.token_hash = ?")
    .bind(hash)
    .first();
  return row ? { ...row, hash } : { hash, missing: true };
}

async function invitePage(app, inv, beta, { errors = [], name = "" } = {}) {
  const csrf = await csrfFor(app, `invite/${inv.hash}`);
  const leak =
    beta.type === "book"
      ? "Your copy is linked to you: downloads are signed and logged per reader, and may carry your reader code."
      : "Your copy is linked to you: downloads are signed and logged per tester.";
  const body =
    `<h1>${e(beta.name)}</h1><p>You're invited. Read the terms below (version ${e(beta.terms.version)}), type your full name and accept to get access.</p>` +
    `<p class="muted">${e(leak)} This invite is personal: whoever accepts it first becomes the tester.</p>${errorList(errors)}` +
    `<div class="terms">${e(beta.terms.text)}</div>` +
    `<form method="post" action="/i/${e(inv.token)}/claim">` +
    `<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="version" value="${e(beta.terms.version)}">` +
    `<label for="full_name">Your full name *</label><input type="text" id="full_name" name="full_name" maxlength="100" required value="${e(name)}">` +
    `<label style="font-weight:400"><input type="checkbox" name="accept" value="1" required> I have read and accept these terms.</label>` +
    `<button type="submit">Accept and continue</button></form>`;
  return page(beta.name, body, errors.length ? 400 : 200);
}

function usable(inv, app) {
  return inv && !inv.missing && inv.status === "sent" && inv.expires_at > app.now;
}

export async function handleInvitePage(request, app, token) {
  const inv = await lookup(app, token);
  if (!usable(inv, app)) return inviteDeadPage();
  const { beta, status } = await betaState(app, inv.beta_id);
  if (!beta || status === "closed") return inviteDeadPage();
  return invitePage(app, { ...inv, token }, beta);
}

export async function handleClaim(request, app, token) {
  if (!sameOrigin(app, request)) return message("Forbidden", "This form must be sent from this site.", 403);
  const parsed = await readForm(request, 32 * 1024);
  if (parsed.tooBig || parsed.bad) return message("Bad request", "Send the invite form.", 400);
  const f = parsed.form;
  const one = (k) => (typeof f.get(k) === "string" ? f.get(k) : "");
  if (!isToken(token)) return inviteDeadPage();
  const hash = await sha256Hex(token);
  if (!(await checkCsrf(app, `invite/${hash}`, one("csrf")))) return message("Expired form", "This form expired. Open your invite link again.", 403);
  const ip = await ipHash(app, request);
  if (!(await d1Hits(app, [{ bucket: `claim:ip:${ip}`, windowMs: HOUR, limit: 10 }]))) return message("Try again later", "Too many attempts. Please try again later.", 429);

  const inv = await lookup(app, token);
  if (!usable(inv, app)) return afterFailedClaim(request, app, inv);
  const { beta, status } = await betaState(app, inv.beta_id);
  if (!beta || status === "closed") return inviteDeadPage();
  const fullName = one("full_name").trim();
  const errors = [];
  if (!fullName || fullName.length > 100) errors.push("Type your full name (up to 100 characters).");
  if (one("accept") !== "1") errors.push("Tick the box to accept the terms.");
  if (errors.length) return invitePage(app, { ...inv, token }, beta, { errors, name: fullName.slice(0, 100) });
  // Terms changed between showing the page and claiming: nothing is claimed; show the new text.
  if (one("version") !== beta.terms.version) return invitePage(app, { ...inv, token }, beta, { errors: ["The terms have changed since you opened this page. Please read the new version."], name: fullName });

  const now = app.now;
  const claimId = randomId("c");
  const sha = await termsSha(beta);
  const db = app.db;
  const claimed = "SELECT tester_id FROM invites WHERE claim_id = ?";
  const stmts = [
    db.prepare("UPDATE invites SET status = 'claimed', claimed_at = ?, claim_id = ? WHERE token_hash = ? AND status = 'sent' AND expires_at > ? RETURNING tester_id").bind(now, claimId, hash, now),
    db
      .prepare(`UPDATE testers SET status = 'active', activated_at = ?, terms_accepted_version = ?, key_status = ? WHERE id = (${claimed}) AND status IN ('approved','invited') RETURNING id, session_ver, beta_id`)
      .bind(now, beta.terms.version, beta.keys ? "pending" : null, claimId),
    db
      .prepare(
        `INSERT INTO acceptances (id, tester_id, email_hmac, beta_id, version, text_sha256, full_name, how, accepted_at)
         SELECT ?, t.id, t.email_hmac, t.beta_id, ?, ?, ?, 'invite', ? FROM testers t WHERE t.id = (${claimed}) AND t.status = 'active'`,
      )
      .bind(randomId("a"), beta.terms.version, sha, fullName, now, claimId),
    db.prepare(`INSERT INTO events (id, tester_id, beta_id, kind, at) SELECT ?, id, beta_id, 'claimed', ? FROM testers WHERE id = (${claimed}) AND status = 'active'`).bind(randomId("e"), now, claimId),
    db.prepare(`DELETE FROM deliveries WHERE tester_id = (${claimed}) AND kind = 'reminder_invite' AND status IN ('pending','retry')`).bind(claimId),
  ];
  if (beta.keys) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO deliveries (id, kind, tester_id, beta_id, ref, dedupe, priority, status, attempts, next_at, created_at)
           SELECT ?, 'key_issue', id, beta_id, NULL, 'key_issue:' || id, ${PRIORITY.key_issue}, 'pending', 0, ?, ? FROM testers WHERE id = (${claimed}) AND status = 'active'
           ON CONFLICT (dedupe) DO NOTHING`,
        )
        .bind(randomId("d"), now, now, claimId),
    );
  }
  const res = await db.batch(stmts);
  const tester = res[1].results[0];
  if (!res[0].results.length || !tester) return afterFailedClaim(request, app, inv);
  if (beta.keys) app.waitUntil(clockStub(app.env).wake().catch(() => {}));
  return redirect(`/t/${tester.beta_id}`, 303, { "Set-Cookie": await sessionCookie(app, tester) });
}

/** A second claim (double-click, two tabs, replay): the tester page if this browser already holds that tester's session. */
async function afterFailedClaim(request, app, inv) {
  if (inv && !inv.missing && inv.status === "claimed") {
    const c = await parseCookie(app, request);
    if (c && c.id === inv.tester_id) return redirect("/t", 303);
  }
  return inviteDeadPage();
}
