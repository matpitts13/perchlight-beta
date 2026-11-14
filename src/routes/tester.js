// The tester's pages (cookie session): builds with signed links, surveys, the
// bug form, terms re-acceptance, settings, export, delete and withdraw
// (docs/SDD.md, "Routes", "Feedback", "Revoke, reminders, privacy").
// Every POST checks Origin and the per-session CSRF value.
import { termsSha } from "../lib/appctx.js";
import { downloadsStopped } from "../lib/betas.js";
import { validateAnswers } from "../lib/config.js";
import { randomId } from "../lib/crypto.js";
import { escapeHtml as e, readForm, redirect, json, isoTime } from "../lib/http.js";
import { sniffImage, EXT } from "../lib/images.js";
import { page, message, questionFields, errorList, shrinkHashCsp, SHRINK_JS } from "../lib/pages.js";
import { d1Hits, DAY } from "../lib/rate.js";
import { loadSession, csrfFor, checkCsrf, testerScope, sameOrigin, clearCookie } from "../lib/session.js";
import { exportData, deleteTesters, endAccessStmts } from "../lib/testers.js";
import { signedDownload, inGroups, buildAvailable } from "./download.js";

export const JSON_MAX = 32 * 1024;
export const MULTIPART_MAX = 900 * 1024;
const SEVERITIES = ["low", "medium", "high", "critical"];

function toSignin(why) {
  return redirect(why === "ended" ? "/signin?ended=1" : "/signin", 303, why === "ended" ? { "Set-Cookie": clearCookie() } : {});
}

/** Session + Origin + CSRF for a POST. Returns { tester, form } or { res }. */
async function guardedPost(request, app, maxBytes) {
  if (!sameOrigin(app, request)) return { res: message("Forbidden", "This form must be sent from this site.", 403) };
  const s = await loadSession(app, request);
  if (!s.tester) return { res: toSignin(s.why) };
  const parsed = await readForm(request, maxBytes);
  if (parsed.tooBig) return { res: message("Too large", `That's over the ${Math.round(maxBytes / 1024)} KB limit. Screenshots can be at most 400 KB each, 2 per bug.`, 413) };
  if (parsed.bad) return { res: message("Bad request", "Send the form.", 400) };
  const csrf = parsed.form.get("csrf");
  if (!(await checkCsrf(app, testerScope(s.tester), typeof csrf === "string" ? csrf : ""))) return { res: message("Expired form", "This form expired. Reload your tester page and try again.", 403) };
  return { tester: s.tester, form: parsed.form };
}

export async function handleTesterHome(request, app) {
  const s = await loadSession(app, request);
  if (!s.tester) return toSignin(s.why);
  return redirect(`/t/${s.tester.beta_id}`, 303);
}

export async function handleTesterPage(request, app, betaId, url) {
  const s = await loadSession(app, request);
  if (!s.tester) return toSignin(s.why);
  const t = s.tester;
  if (t.beta_id !== betaId) return redirect(`/t/${t.beta_id}`, 303);
  const beta = app.cfg.byId.get(betaId);
  if (!beta) return message("Not available", "This beta is switched off.", 503);
  const csrf = await csrfFor(app, testerScope(t));
  const hidden = `<input type="hidden" name="csrf" value="${csrf}">`;

  if (t.terms_accepted_version !== beta.terms.version) {
    const body =
      `<h1>${e(beta.name)}</h1><p>The terms have changed (now version ${e(beta.terms.version)}). Please read and accept them again before downloading.</p>` +
      `<div class="terms">${e(beta.terms.text)}</div><form method="post" action="/t/${e(beta.id)}/terms">${hidden}<input type="hidden" name="version" value="${e(beta.terms.version)}">` +
      `<label for="full_name">Your full name *</label><input type="text" id="full_name" name="full_name" maxlength="100" required>` +
      `<label style="font-weight:400"><input type="checkbox" name="accept" value="1" required> I have read and accept these terms.</label><button type="submit">Accept</button></form>`;
    return page(beta.name, body);
  }

  const now = app.now;
  const [bRes, rRes] = await app.db.batch([
    app.db.prepare("SELECT id, label, platform, notes, source, survey_id, groups, available_at, expires_at FROM builds WHERE beta_id = ? AND config_error IS NULL ORDER BY available_at DESC LIMIT 100").bind(beta.id),
    app.db.prepare("SELECT survey_id, answers FROM responses WHERE tester_id = ?").bind(t.id),
  ]);
  const builds = bRes.results.filter((b) => buildAvailable(b, now) && inGroups(b, t));
  const responses = new Map(rRes.results.map((r) => [r.survey_id, JSON.parse(r.answers)]));
  const stopped = downloadsStopped(beta, t.closed_at, now);
  const surveysOpen = !t.closed_at;

  const buildRows = [];
  for (const b of builds) {
    const link = stopped ? "" : `<a href="${e(await signedDownload(app, b.id, t.id))}">Download</a>`;
    buildRows.push(`<li><strong>${e(b.label)}</strong>${b.platform ? ` (${e(b.platform)})` : ""} ${link}${b.notes ? `<br><span class="muted">${e(b.notes)}</span>` : ""}</li>`);
  }
  const surveyIds = [...new Set(builds.map((b) => b.survey_id).filter((x) => x && app.cfg.surveys[x]))];
  const surveys = surveyIds
    .map((sid) => {
      const sv = app.cfg.surveys[sid];
      const prev = responses.get(sid);
      const b = builds.find((x) => x.survey_id === sid);
      return surveysOpen
        ? `<h3>Survey: ${e(b.label)}${prev ? " (answered; you can edit it)" : ""}</h3><form method="post" action="/t/${e(beta.id)}/survey/${e(sid)}">${hidden}<input type="hidden" name="build" value="${e(b.id)}">${questionFields(sv.questions, prev ?? {})}<button type="submit">Save</button></form>`
        : `<h3>Survey: ${e(b.label)}</h3><p class="muted">This survey is closed.</p>`;
    })
    .join("");
  const saved = { survey: "Your survey answers were saved.", terms: "Thanks, the new terms are accepted.", reminders: "Your reminder setting was saved." }[url.searchParams.get("saved") ?? ""];
  const keyLine = beta.keys
    ? `<p>Your beta key: ${e({ pending: "on its way by email", issued: "sent to you by email", failed: "delayed; we're on it", revoking: "revoked", revoked: "revoked" }[t.key_status] ?? "on its way by email")}.</p>`
    : "";
  const body =
    `<h1>${e(beta.name)}</h1>${saved ? `<p><strong>${e(saved)}</strong></p>` : ""}<p>Signed in as ${e(t.name ?? t.email)}. Your reader code: <strong>${e(t.reader_code.slice(0, 4))}-${e(t.reader_code.slice(4))}</strong></p>${keyLine}` +
    `<h2>Builds</h2>${stopped ? "<p>This beta has ended; downloads are closed.</p>" : ""}<ul>${buildRows.join("") || "<li>Nothing to download yet.</li>"}</ul><p class="muted">Download links work for 15 minutes; reload this page for fresh ones. Your copy is linked to you.</p>` +
    `${surveys ? `<h2>Surveys</h2>${surveys}` : ""}` +
    `<h2>Report a bug</h2><form method="post" action="/t/${e(beta.id)}/bugs" enctype="multipart/form-data">${hidden}` +
    `<label for="title">Title *</label><input type="text" id="title" name="title" maxlength="200" required>` +
    `<label for="body">Steps and details *</label><textarea id="body" name="body" maxlength="10000" rows="6" required></textarea>` +
    `<label for="severity">Severity</label><select id="severity" name="severity">${SEVERITIES.map((x) => `<option${x === "medium" ? " selected" : ""}>${x}</option>`).join("")}</select>` +
    `<label for="platform">Platform</label><input type="text" id="platform" name="platform" maxlength="50">` +
    `<label for="build">Build</label><select id="build" name="build"><option value=""></option>${builds.map((b) => `<option value="${e(b.id)}">${e(b.label)}</option>`).join("")}</select>` +
    `<label for="screenshot">Screenshots (up to 2; PNG, JPEG or WebP; 400 KB each)</label><input type="file" id="screenshot" name="screenshot" accept="image/png,image/jpeg,image/webp" multiple data-shrink>` +
    `<p class="muted">Screenshots are sent as-is (shrunk in your browser first when scripts are on).</p><button type="submit">Send report</button></form>` +
    `<h2>Settings</h2><form method="post" action="/t/me/reminders">${hidden}<input type="hidden" name="off" value="${t.reminders_off ? "0" : "1"}"><p>Reminder emails are ${t.reminders_off ? "off" : "on"}.</p><button type="submit">Turn reminders ${t.reminders_off ? "on" : "off"}</button></form>` +
    `<h2>Your data</h2><p><a href="/t/me/export">Download everything we hold about you (JSON)</a></p>` +
    `<form method="post" action="/t/${e(beta.id)}/withdraw">${hidden}<button type="submit">Leave this beta</button></form>` +
    `<form method="post" action="/t/me/delete">${hidden}<p class="muted">Deleting removes you from every beta here. Only a pseudonymised record that the terms were accepted is kept.</p><button type="submit">Delete my data</button></form>` +
    `<script>${SHRINK_JS}</script>`;
  return page(beta.name, body, 200, { scriptHashes: [await shrinkHashCsp()] });
}

export async function handleReaccept(request, app, betaId) {
  const g = await guardedPost(request, app, JSON_MAX);
  if (g.res) return g.res;
  const t = g.tester;
  const beta = app.cfg.byId.get(betaId);
  if (!beta || t.beta_id !== betaId) return message("Not found", "Not found.", 404);
  const fullName = String(g.form.get("full_name") ?? "").trim();
  if (g.form.get("accept") !== "1" || !fullName || fullName.length > 100 || g.form.get("version") !== beta.terms.version) return redirect(`/t/${beta.id}`, 303);
  const now = app.now;
  await app.db.batch([
    app.db
      .prepare("INSERT INTO acceptances (id, tester_id, email_hmac, beta_id, version, text_sha256, full_name, how, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, 're-accept', ?)")
      .bind(randomId("a"), t.id, t.email_hmac, beta.id, beta.terms.version, await termsSha(beta), fullName, now),
    app.db.prepare("UPDATE testers SET terms_accepted_version = ? WHERE id = ?").bind(beta.terms.version, t.id),
  ]);
  return redirect(`/t/${beta.id}?saved=terms`, 303);
}

export async function handleSurvey(request, app, betaId, surveyId) {
  const g = await guardedPost(request, app, JSON_MAX);
  if (g.res) return g.res;
  const t = g.tester;
  const beta = app.cfg.byId.get(betaId);
  const survey = app.cfg.surveys[surveyId];
  if (!beta || t.beta_id !== betaId || !survey) return message("Not found", "No such survey.", 404);
  if (t.closed_at) return message("Survey closed", "This survey is closed.", 403);
  const buildId = String(g.form.get("build") ?? "");
  const build = await app.db.prepare("SELECT id FROM builds WHERE id = ? AND beta_id = ? AND survey_id = ?").bind(buildId, beta.id, surveyId).first();
  if (!build) return message("Not found", "No such survey.", 404);
  const { answers, errors } = validateAnswers(survey.questions, (k) => g.form.getAll(k).filter((v) => typeof v === "string"));
  if (errors.length) return page("Survey", `<h1>Survey</h1>${errorList(errors)}<p><a href="/t/${e(beta.id)}">Back</a></p>`, 400);
  if (!(await d1Hits(app, [{ bucket: `survey:${t.id}`, windowMs: DAY, limit: 50 }]))) return message("Try again tomorrow", "You've sent a lot of survey answers today. Please try again tomorrow.", 429);
  const now = app.now;
  await app.db.batch([
    app.db
      .prepare(
        "INSERT INTO responses (survey_id, tester_id, build_id, beta_id, answers, submitted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (survey_id, tester_id) DO UPDATE SET answers = excluded.answers, build_id = excluded.build_id, updated_at = excluded.updated_at",
      )
      .bind(surveyId, t.id, build.id, beta.id, JSON.stringify(answers), now, now),
    app.db.prepare("INSERT INTO events (id, tester_id, beta_id, kind, at, detail) VALUES (?, ?, ?, 'survey', ?, ?)").bind(randomId("e"), t.id, beta.id, now, JSON.stringify({ survey: surveyId })),
  ]);
  return redirect(`/t/${beta.id}?saved=survey`, 303);
}

export async function handleBug(request, app, betaId) {
  const g = await guardedPost(request, app, MULTIPART_MAX);
  if (g.res) return g.res;
  const t = g.tester;
  const beta = app.cfg.byId.get(betaId);
  if (!beta || t.beta_id !== betaId) return message("Not found", "Not found.", 404);
  const f = g.form;
  const str = (k) => (typeof f.get(k) === "string" ? f.get(k).trim() : "");
  const title = str("title");
  const body = str("body");
  const severity = str("severity") || "medium";
  const platform = str("platform");
  const buildId = str("build");
  const errors = [];
  if (!title || title.length > 200) errors.push("A title (up to 200 characters) is required.");
  if (!body || new TextEncoder().encode(body).length > 10 * 1024) errors.push("Steps and details are required (up to 10 KB).");
  if (!SEVERITIES.includes(severity)) errors.push("Choose a severity.");
  if (platform.length > 50) errors.push("Platform: up to 50 characters.");
  const sc = app.cfg.screenshots;
  const files = f.getAll("screenshot").filter((x) => typeof x === "object" && x !== null && typeof x.arrayBuffer === "function" && x.size > 0);
  if (files.length > sc.perBug) errors.push(`At most ${sc.perBug} screenshots per bug.`);
  const images = [];
  if (!errors.length) {
    for (const file of files) {
      if (file.size > sc.maxBytes) {
        errors.push(`Each screenshot must be at most ${Math.round(sc.maxBytes / 1024)} KB.`);
        break;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mime = sniffImage(bytes);
      if (!mime) {
        errors.push("Screenshots must be PNG, JPEG or WebP images.");
        break;
      }
      images.push({ bytes, mime });
    }
  }
  if (errors.length) return page("Bug report", `<h1>Bug report</h1>${errorList(errors)}<p><a href="/t/${e(beta.id)}">Back</a></p>`, 400);
  let build = null;
  if (buildId) build = await app.db.prepare("SELECT id FROM builds WHERE id = ? AND beta_id = ?").bind(buildId, beta.id).first();
  if (!(await d1Hits(app, [{ bucket: `bugs:${t.id}`, windowMs: DAY, limit: 20 }]))) return message("Try again tomorrow", "You've sent 20 bug reports today. Please try again tomorrow.", 429);

  const now = app.now;
  const id = randomId("bug");
  let note = null;
  let kept = images;
  if (images.length) {
    const used = (await app.db.prepare(`SELECT COALESCE(SUM(size), 0) AS n FROM bug_images WHERE ${sc.store === "r2" ? "r2_key IS NOT NULL" : "data IS NOT NULL"}`).first())?.n ?? 0;
    const adding = images.reduce((n, i) => n + i.bytes.length, 0);
    if (used + adding > sc.totalCap || (sc.store === "r2" && !app.env.FILES)) {
      kept = [];
      note = "Screenshot storage is full: the report was saved without its screenshots.";
    }
  }
  const stmts = [
    app.db
      .prepare("INSERT INTO bugs (id, tester_id, beta_id, build_id, title, body, severity, platform, status, images, images_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)")
      .bind(id, t.id, beta.id, build?.id ?? null, title, body, severity, platform || null, kept.length, note, now),
    app.db.prepare("INSERT INTO events (id, tester_id, beta_id, kind, at, detail) VALUES (?, ?, ?, 'bug', ?, ?)").bind(randomId("e"), t.id, beta.id, now, JSON.stringify({ bug: id, images_dropped: note ? images.length : 0 })),
  ];
  for (const [i, img] of kept.entries()) {
    if (sc.store === "r2") {
      const key = `bugs/${id}/${i + 1}.${EXT[img.mime]}`;
      await app.env.FILES.put(key, img.bytes, { httpMetadata: { contentType: img.mime } });
      stmts.push(app.db.prepare("INSERT INTO bug_images (bug_id, n, mime, size, r2_key) VALUES (?, ?, ?, ?, ?)").bind(id, i + 1, img.mime, img.bytes.length, key));
    } else {
      stmts.push(app.db.prepare("INSERT INTO bug_images (bug_id, n, mime, size, data) VALUES (?, ?, ?, ?, ?)").bind(id, i + 1, img.mime, img.bytes.length, img.bytes));
    }
  }
  await app.db.batch(stmts);
  return page("Bug report", `<h1>Thanks</h1><p>Your bug report was saved.</p>${note ? `<p class="err">${e(note)}</p>` : ""}<p><a href="/t/${e(beta.id)}">Back to your tester page</a></p>`);
}

export async function handleReminders(request, app) {
  const g = await guardedPost(request, app, JSON_MAX);
  if (g.res) return g.res;
  const off = g.form.get("off") === "1" ? 1 : 0;
  await app.db.prepare("UPDATE testers SET reminders_off = ? WHERE email_hmac = ?").bind(off, g.tester.email_hmac).run();
  return redirect(`/t/${g.tester.beta_id}?saved=reminders`, 303);
}

export async function handleExport(request, app) {
  const s = await loadSession(app, request);
  if (!s.tester) return toSignin(s.why);
  const data = await exportData(app, s.tester.email_hmac);
  return json(data, 200, { "Content-Disposition": `attachment; filename="perchlight-beta-export-${isoTime(app.now).slice(0, 10)}.json"` });
}

export async function handleWithdraw(request, app, betaId) {
  const g = await guardedPost(request, app, JSON_MAX);
  if (g.res) return g.res;
  if (g.tester.beta_id !== betaId) return message("Not found", "Not found.", 404);
  await app.db.batch([
    ...endAccessStmts(app.db, [g.tester.id], "withdrawn", app.now),
    app.db.prepare("INSERT INTO events (id, tester_id, beta_id, kind, at) VALUES (?, ?, ?, 'withdrawn', ?)").bind(randomId("e"), g.tester.id, betaId, app.now),
  ]);
  return message("You've left the beta", "You've left the beta. Thanks for testing. Anything you downloaded stays with you; please delete it as the terms ask.", 200, { "Set-Cookie": clearCookie() });
}

/** Deletes every tester row for this person (all betas), withdrawing first. */
export async function deletePerson(app, emailHmacValue) {
  const rows = (await app.db.prepare("SELECT id, beta_id FROM testers WHERE email_hmac = ?").bind(emailHmacValue).all()).results;
  let deleted = 0;
  const r2Keys = [];
  const byBeta = new Map();
  for (const r of rows) byBeta.set(r.beta_id, [...(byBeta.get(r.beta_id) ?? []), r.id]);
  for (const [betaId, ids] of byBeta) {
    const beta = app.cfg.byId.get(betaId);
    await app.db.batch(endAccessStmts(app.db, ids, "withdrawn", app.now));
    const r = await deleteTesters(app, ids, { keepBugs: beta?.keepBugs ?? false, acceptanceDays: beta?.retention.acceptanceDays ?? 730 });
    deleted += r.deleted;
    r2Keys.push(...r.r2Keys);
  }
  if (r2Keys.length && app.env.FILES) await app.env.FILES.delete(r2Keys).catch(() => {});
  return deleted;
}

export async function handleDelete(request, app) {
  const g = await guardedPost(request, app, JSON_MAX);
  if (g.res) return g.res;
  await deletePerson(app, g.tester.email_hmac);
  return message("Deleted", "Your data was deleted. Only a pseudonymised record that you accepted the terms is kept, as the README explains.", 200, { "Set-Cookie": clearCookie() });
}
