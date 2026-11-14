// GET /b/:beta and POST /b/:beta/apply (docs/SDD.md, "Recruiting and
// screening"). One uniform answer (same status, body and headers) for a new
// application, a repeat from the same email (answers updated, no second row),
// a closed beta's waitlist and a blocked address. No email is sent on apply.
import { betaState } from "../lib/betas.js";
import { validateAnswers } from "../lib/config.js";
import { readerCode, randomId } from "../lib/crypto.js";
import { escapeHtml as e } from "../lib/http.js";
import { readForm } from "../lib/http.js";
import { page, message, thanksPage, questionFields, errorList, NOT_OPEN_TEXT } from "../lib/pages.js";
import { d1Hits, ipHash, HOUR, DAY } from "../lib/rate.js";
import { verifyTurnstile } from "../lib/turnstile.js";
import { normEmail, emailHmac } from "../lib/testers.js";

export const APPLY_MAX_BYTES = 32 * 1024;

function notOpen() {
  return message("Not open", NOT_OPEN_TEXT, 200);
}

function form(app, beta, status, { values = {}, errors = [], src = null } = {}) {
  const intro = status === "closed" ? "<p>Applications are closed, but you can join the waitlist.</p>" : "";
  const kind = { game: "game", app: "app", book: "book" }[beta.type];
  const body =
    `<h1>${e(beta.name)}</h1>${intro}<p class="muted">Apply to test this ${kind}. We only use your details for this beta.</p>${errorList(errors)}` +
    `<form method="post" action="/b/${e(beta.id)}/apply">` +
    `<label for="name">Your name *</label><input type="text" id="name" name="name" maxlength="100" required value="${e(values.name ?? "")}">` +
    `<label for="email">Email *</label><input type="email" id="email" name="email" maxlength="254" required value="${e(values.email ?? "")}">` +
    questionFields(beta.questions, values) +
    `<div class="hp" aria-hidden="true"><label for="website">Leave this empty</label><input type="text" id="website" name="website" tabindex="-1" autocomplete="off"></div>` +
    (src ? `<input type="hidden" name="src" value="${e(src)}">` : "") +
    `<div class="cf-turnstile" data-sitekey="${e(app.env.TURNSTILE_SITE_KEY ?? "")}" style="margin-top:1rem"></div>` +
    `<button type="submit">Apply</button></form>`;
  return page(beta.name, body, errors.length ? 400 : 200, { turnstile: true });
}

export async function handleApplyPage(request, app, betaId, url) {
  const { beta, status } = await betaState(app, betaId);
  if (!beta || (status !== "open" && status !== "closed")) return notOpen();
  const src = url.searchParams.get("src");
  return form(app, beta, status, { src: src && beta.sources.includes(src) ? src : null });
}

export async function handleApply(request, app, betaId) {
  const { beta, status } = await betaState(app, betaId);
  if (!beta || (status !== "open" && status !== "closed")) return notOpen();
  const parsed = await readForm(request, APPLY_MAX_BYTES);
  if (parsed.tooBig) return message("Too large", "That application is too large.", 413);
  if (parsed.bad) return message("Bad request", "Send the application form.", 400);
  const f = parsed.form;
  const asJson = parsed.json || /application\/json/.test(request.headers.get("Accept") ?? "");
  const one = (k) => {
    const v = f.get(k);
    return typeof v === "string" ? v : "";
  };
  // Honeypot (as perchlight-list): answered like a success, nothing stored.
  if (one("website")) return thanksPage(asJson);

  const values = { name: one("name").trim(), email: one("email").trim() };
  const errors = [];
  if (!values.name || values.name.length > 100) errors.push("Your name is required (up to 100 characters).");
  const email = normEmail(values.email);
  if (!email) errors.push("A valid email address is required.");
  const { answers, errors: qErrors } = validateAnswers(beta.questions, (k) => f.getAll(k).filter((v) => typeof v === "string"));
  errors.push(...qErrors);
  for (const q of beta.questions) if (answers[q.id] !== undefined) values[q.id] = answers[q.id];
  const srcRaw = one("src");
  const src = srcRaw && beta.sources.includes(srcRaw) ? srcRaw : null;
  if (errors.length) return asJson ? new Response(JSON.stringify({ ok: false, errors }), { status: 400, headers: { "Content-Type": "application/json" } }) : form(app, beta, status, { values, errors, src });

  // Turnstile (fails closed), then rate limits, then the one write.
  const ts = await verifyTurnstile(app.env, one("cf-turnstile-response"), request.headers.get("CF-Connecting-IP"));
  if (!ts.ok) {
    const msg = "Please complete the check below and try again.";
    return asJson ? new Response(JSON.stringify({ ok: false, errors: [msg] }), { status: 400, headers: { "Content-Type": "application/json" } }) : form(app, beta, status, { values, errors: [msg], src });
  }
  const ip = await ipHash(app, request);
  let allowed;
  try {
    allowed = await d1Hits(app, [
      { bucket: `apply:ip:${ip}`, windowMs: HOUR, limit: 5 },
      { bucket: `apply:beta:${beta.id}`, windowMs: DAY, limit: 500 },
    ]);
  } catch {
    return message("Try again later", "Please try again later.", 503);
  }
  if (!allowed) return message("Try again later", "Too many applications right now. Please try again later.", 429, { "Retry-After": "3600" });

  const hmac = await emailHmac(app, email);
  const now = app.now;
  const newStatus = status === "open" ? "applied" : "waitlisted";
  const answersJson = JSON.stringify(answers);
  const write = () =>
    app.db.batch([
      app.db
        .prepare(
          `INSERT INTO testers (id, beta_id, email, email_hmac, name, answers, src, status, reader_code, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (beta_id, email_hmac) DO UPDATE SET name = excluded.name, email = excluded.email, answers = excluded.answers, src = COALESCE(excluded.src, testers.src), applied_at = excluded.applied_at
           WHERE testers.status IN ('applied','waitlisted')`,
        )
        .bind(randomId("t"), beta.id, email, hmac, values.name, answersJson, src, newStatus, readerCode(), now),
      app.db
        .prepare("INSERT INTO events (id, tester_id, beta_id, kind, at, detail) SELECT ?, id, beta_id, 'applied', ?, ? FROM testers WHERE beta_id = ? AND email_hmac = ? AND applied_at = ? AND status IN ('applied','waitlisted')")
        .bind(randomId("e"), now, src ? JSON.stringify({ src }) : null, beta.id, hmac, now),
    ]);
  try {
    await write();
  } catch (err) {
    // A reader-code collision (40 bits) is retried once; anything else (D1 out of writes) is a 503.
    if (!/UNIQUE constraint failed: testers\.reader_code/.test(String(err?.message ?? err))) return message("Try again later", "Please try again later.", 503);
    try {
      await write();
    } catch {
      return message("Try again later", "Please try again later.", 503);
    }
  }
  return thanksPage(asJson);
}
