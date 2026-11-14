// The admin API (docs/SDD.md, "Admin API"): Authorization: Bearer <ADMIN_TOKEN>,
// compared in constant time (hash then compare), refused if the token is
// under 16 characters. Every query is parameterised.
import { clockStub } from "../lib/appctx.js";
import { checkBuild } from "../lib/config.js";
import { safeEqual, randomId, readerCode } from "../lib/crypto.js";
import { json, fail, readJson, utcDay } from "../lib/http.js";
import { decide, exportData, deleteTesters, endAccessStmts, normEmail, emailHmac } from "../lib/testers.js";
import { daysToSend, EMAIL_KINDS } from "../lib/queue.js";
import { resolveAsset } from "../lib/github.js";
import { keysTransport } from "../lib/keys.js";

const TESTER = /^t_[a-z0-9]{16}$/;
const lim = (v, d, max) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : d;
};

export async function authorized(app, request) {
  const token = String(app.env.ADMIN_TOKEN ?? "");
  if (token.length < 16) return { ok: false, res: fail(503, "ADMIN_TOKEN must be set to 16+ characters.") };
  const h = request.headers.get("Authorization") ?? "";
  const m = /^Bearer (.{1,512})$/.exec(h);
  if (!m || !(await safeEqual(m[1], token))) return { ok: false, res: fail(401, "Unauthorized.") };
  return { ok: true };
}

/** Problems with secrets and bindings, as the config check shows them. */
export function configWarnings(app) {
  const env = app.env;
  const w = [];
  const need = (name, n) => {
    if (String(env[name] ?? "").length < n) w.push(`${name} must be set (${n}+ characters).`);
  };
  need("ADMIN_TOKEN", 16);
  need("LINK_SECRET", 32);
  need("SESSION_SECRET", 32);
  need("IP_SALT", 16);
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) w.push("Tester email is off: set MAIL_FROM (var) and RESEND_API_KEY (secret).");
  if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY) w.push("Applications and sign-in need Turnstile: set TURNSTILE_SITE_KEY (var) and TURNSTILE_SECRET_KEY (secret).");
  if (!env.OWNER_EMAIL || !env.EMAIL) w.push("Owner notices are off: set OWNER_EMAIL (a verified Email Routing address) and keep the EMAIL send_email binding.");
  if (!String(env.PUBLIC_URL ?? "").startsWith("https://")) w.push("Set PUBLIC_URL to this deployment's https URL (used in emails and the Origin check).");
  const builds = app.cfg.builds.filter((b) => !b.error);
  if (builds.some((b) => b.source === "github") && !env.GITHUB_TOKEN) w.push("A build uses source github: set GITHUB_TOKEN (fine-grained, Contents: read, that repository only).");
  if ((builds.some((b) => b.source === "r2") || app.cfg.screenshots.store === "r2") && !env.FILES) w.push("R2 is used: add the FILES r2_buckets binding.");
  if (app.cfg.betas.some((b) => !b.error && b.keys)) {
    const t = keysTransport(env);
    if (t.error) w.push(`perchlight-keys: ${t.error}. Keys stay pending.`);
    w.push("perchlight-keys emails keys from its own Resend quota: if both deployments share one Resend account, lower email.dailyCap so the two together stay under 100 a day.");
    if (t.kind === "binding") w.push("perchlight-keys has only a full ADMIN_TOKEN today; KEYS_TOKEN grants full admin there until its scoped ISSUE_TOKEN exists.");
  }
  return w;
}

/** Rough daily estimate for the config check (docs/SDD.md, "Footprint"). */
function estimate(app) {
  const open = app.cfg.betas.filter((b) => !b.error && b.status !== "draft");
  const testers = open.reduce((n, b) => n + Math.min(b.maxTesters, 150), 0);
  return {
    d1RowsWrittenPerDay: Math.round(testers * 12 + open.length * 25 * 4),
    emailsPerDayAtBusiest: Math.min(app.cfg.email.dailyCap, Math.round(testers * 0.6)),
    note: "Assumes each beta at the SDD's example busy week (up to 150 testers each). Email is the binding limit.",
  };
}

export async function handleAdmin(request, app, path) {
  const auth = await authorized(app, request);
  if (!auth.ok) return auth.res;
  const url = new URL(request.url);
  const q = url.searchParams;
  const m = request.method;
  const db = app.db;
  let body = {};
  if (m === "POST" || m === "PATCH") {
    const b = await readJson(request, 32 * 1024);
    if (b === null) return fail(400, "Send a JSON object of at most 32 KB.");
    body = b;
  }
  let g;

  if (m === "GET" && path === "betas") {
    const rows = (await db.prepare("SELECT beta_id, status, COUNT(*) AS n FROM testers GROUP BY beta_id, status").all()).results;
    const closed = new Map((await db.prepare("SELECT id, closed_at FROM betas").all()).results.map((r) => [r.id, r.closed_at]));
    return json({
      betas: app.cfg.betas.map((b) => ({
        id: b.id,
        name: b.name,
        type: b.type ?? null,
        status: closed.get(b.id) ? "closed" : (b.status ?? null),
        closed_at: closed.get(b.id) ?? null,
        config_error: b.error,
        counts: Object.fromEntries(rows.filter((r) => r.beta_id === b.id).map((r) => [r.status, r.n])),
      })),
      builds: app.cfg.builds.filter((b) => b.error).map((b) => ({ id: b.id, config_error: b.error })),
      surveys: app.cfg.surveyErrors,
      errors: app.cfg.errors,
      warnings: configWarnings(app),
      estimate: estimate(app),
    });
  }
  if ((g = /^betas\/([a-z0-9][a-z0-9_-]{0,39})\/close$/.exec(path)) && m === "POST") {
    const beta = app.cfg.byId.get(g[1]);
    if (!beta) return fail(404, "No such beta.");
    const now = app.now;
    await db.batch([
      db
        .prepare("INSERT INTO betas (id, name, type, status, closed_at, updated_at) VALUES (?, ?, ?, 'closed', ?, ?) ON CONFLICT (id) DO UPDATE SET status = 'closed', closed_at = COALESCE(betas.closed_at, excluded.closed_at), updated_at = excluded.updated_at")
        .bind(beta.id, beta.name, beta.type, now, now),
      db.prepare("UPDATE invites SET status = 'revoked' WHERE status IN ('queued','sent') AND tester_id IN (SELECT id FROM testers WHERE beta_id = ?)").bind(beta.id),
      db.prepare("DELETE FROM deliveries WHERE beta_id = ? AND kind IN ('invite','reminder_invite','new_build','reminder_survey','reminder_ending') AND status IN ('pending','retry')").bind(beta.id),
    ]);
    return json({ ok: true, closed_at: now, downloads_stop_at: now + beta.closeGraceDays * 86_400_000 });
  }

  if (m === "GET" && path === "applications") {
    const statuses = (q.get("status") ?? "applied,waitlisted").split(",").filter((s) => /^[a-z]{1,12}$/.test(s)).slice(0, 9);
    const where = [`status IN (${statuses.map(() => "?").join(",") || "''"})`];
    const params = [...statuses];
    if (q.get("beta")) {
      where.push("beta_id = ?");
      params.push(q.get("beta"));
    }
    const rows = (
      await db
        .prepare(`SELECT id, beta_id, name, email, src, status, answers, note, applied_at, decided_at FROM testers WHERE ${where.join(" AND ")} ORDER BY applied_at DESC LIMIT ?`)
        .bind(...params, lim(q.get("limit"), 200, 1000))
        .all()
    ).results;
    for (const r of rows) r.answers = r.answers ? JSON.parse(r.answers) : null;
    return json({ applications: rows });
  }
  if (m === "POST" && path === "applications/decide") {
    const action = body.action;
    if (!["approve", "decline", "waitlist", "block"].includes(action)) return fail(400, "action: approve, decline, waitlist or block.");
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 1000 || body.ids.some((x) => typeof x !== "string" || !TESTER.test(x))) return fail(400, "ids: 1-1000 tester ids.");
    const r = await decide(app, body.ids, action);
    const res = { ok: true, ...r };
    if (action === "approve" && r.invites) {
      res.email = await queueReport(app, r.invites);
      app.waitUntil(clockStub(app.env).wake().catch(() => {}));
    }
    return json(res);
  }

  if (m === "POST" && path === "invites") {
    const beta = app.cfg.byId.get(body.beta);
    if (!beta) return fail(400, "beta: an existing beta id.");
    const email = normEmail(body.email);
    if (!email) return fail(400, "email: a valid address.");
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) || null : null;
    const hmac = await emailHmac(app, email);
    await db
      .prepare(
        `INSERT INTO testers (id, beta_id, email, email_hmac, name, answers, src, status, reader_code, applied_at) VALUES (?, ?, ?, ?, ?, NULL, 'manual', 'applied', ?, ?)
         ON CONFLICT (beta_id, email_hmac) DO UPDATE SET name = COALESCE(excluded.name, testers.name), email = excluded.email WHERE testers.status IN ('applied','waitlisted','declined')`,
      )
      .bind(randomId("t"), beta.id, email, hmac, name, readerCode(), app.now)
      .run();
    const t = await db.prepare("SELECT id, status FROM testers WHERE beta_id = ? AND email_hmac = ?").bind(beta.id, hmac).first();
    if (!t || !["applied", "waitlisted", "declined"].includes(t.status)) return fail(409, `This address is already ${t?.status ?? "known"} in this beta.`, { tester_id: t?.id ?? null });
    const r = await decide(app, [t.id], "approve");
    if (r.invites) app.waitUntil(clockStub(app.env).wake().catch(() => {}));
    return json({ ok: true, tester_id: t.id, ...r, email: r.invites ? await queueReport(app, 1) : null }, r.invites ? 201 : 200);
  }
  if ((g = /^invites\/(i_[a-f0-9]{20})\/(resend|revoke)$/.exec(path)) && m === "POST") {
    const inv = await db.prepare("SELECT id, tester_id, status FROM invites WHERE id = ?").bind(g[1]).first();
    if (!inv) return fail(404, "No such invite.");
    if (g[2] === "revoke") {
      const res = await db.batch([
        db.prepare("UPDATE invites SET status = 'revoked' WHERE id = ? AND status IN ('queued','sent')").bind(inv.id),
        db.prepare("DELETE FROM deliveries WHERE ref = ? AND kind IN ('invite','reminder_invite') AND status IN ('pending','retry')").bind(inv.id),
      ]);
      return json({ ok: true, revoked: res[0].meta.changes > 0 });
    }
    const r = await decide(app, [inv.tester_id], "resend_invite");
    if (r.invites) app.waitUntil(clockStub(app.env).wake().catch(() => {}));
    return json({ ok: true, ...r });
  }

  if ((g = /^testers\/(t_[a-z0-9]{16})(\/(revoke|export))?$/.exec(path))) {
    const t = await db.prepare("SELECT * FROM testers WHERE id = ?").bind(g[1]).first();
    if (!t) return fail(404, "No such tester.");
    if (m === "GET" && !g[3]) {
      const res = await db.batch([
        db.prepare("SELECT id, status, created_at, sent_at, expires_at, claimed_at FROM invites WHERE tester_id = ? ORDER BY created_at DESC").bind(t.id),
        db.prepare("SELECT COUNT(*) AS n FROM downloads WHERE tester_id = ? AND result = 'started'").bind(t.id),
        db.prepare("SELECT (SELECT COUNT(*) FROM responses WHERE tester_id = ?) + (SELECT COUNT(*) FROM bugs WHERE tester_id = ?) AS n").bind(t.id, t.id),
      ]);
      const { email_hmac, ...rest } = t;
      void email_hmac;
      return json({ tester: { ...rest, answers: t.answers ? JSON.parse(t.answers) : null }, invites: res[0].results, downloads: res[1].results[0].n, feedback: res[2].results[0].n });
    }
    if (m === "POST" && g[3] === "revoke") return json({ ok: true, ...(await decide(app, [t.id], "revoke")) });
    if (m === "GET" && g[3] === "export") {
      const all = await exportData(app, t.email_hmac);
      return json({ ...all, testers: all.testers.filter((x) => x.id === t.id), note: "Rows for this tester; the tester's own export covers every beta they're in." });
    }
    if (m === "DELETE" && !g[3]) {
      const beta = app.cfg.byId.get(t.beta_id);
      await db.batch(endAccessStmts(db, [t.id], "withdrawn", app.now));
      const r = await deleteTesters(app, [t.id], { keepBugs: beta?.keepBugs ?? false, acceptanceDays: beta?.retention.acceptanceDays ?? 730 });
      if (r.r2Keys.length && app.env.FILES) await app.env.FILES.delete(r.r2Keys).catch(() => {});
      return json({ ok: true, deleted: r.deleted });
    }
  }

  if (path === "builds" && m === "GET") {
    const rows = q.get("beta")
      ? (await db.prepare("SELECT * FROM builds WHERE beta_id = ? ORDER BY available_at DESC").bind(q.get("beta")).all()).results
      : (await db.prepare("SELECT * FROM builds ORDER BY available_at DESC LIMIT 500").all()).results;
    return json({ builds: rows });
  }
  if (path === "builds" && m === "POST") {
    const exists = await db.prepare("SELECT id FROM builds WHERE id = ?").bind(String(body.id ?? "")).first();
    if (exists) return fail(409, "A build with this id exists.");
    const r = checkBuild(body.id, body, { betaIds: new Set(app.cfg.byId.keys()), surveys: app.cfg.surveys, ownHost: app.host });
    if (r.error) return fail(400, r.error);
    const b = r.build;
    const now = app.now;
    await db
      .prepare(
        "INSERT INTO builds (id, beta_id, label, platform, notes, source, target, groups, survey_id, available_at, expires_at, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', ?)",
      )
      .bind(b.id, b.beta, b.label, b.platform, b.notes, b.source, b.target, b.groups ? b.groups.join(",") : null, b.survey, b.availableAt ?? now, b.expiresAt, now)
      .run();
    return json({ ok: true, build: b }, 201);
  }
  if ((g = /^builds\/([a-z0-9][a-z0-9_-]{0,39})(\/resolve)?$/.exec(path))) {
    const row = await db.prepare("SELECT * FROM builds WHERE id = ?").bind(g[1]).first();
    if (!row) return fail(404, "No such build.");
    if (m === "PATCH" && !g[2]) {
      if (row.origin !== "api") return fail(409, "This build comes from beta.json; change it there.");
      const merged = {
        beta: row.beta_id,
        label: body.label ?? row.label,
        platform: body.platform ?? row.platform,
        notes: body.notes ?? row.notes,
        source: row.source,
        url: row.source === "link" ? (body.url ?? row.target) : undefined,
        ...(row.source === "github" ? (() => { const [o, r, t, ...a] = row.target.split("/"); return { repo: `${o}/${r}`, tag: t, asset: a.join("/") }; })() : {}),
        key: row.source === "r2" ? row.target : undefined,
        groups: body.groups !== undefined ? body.groups : row.groups ? row.groups.split(",") : null,
        survey: body.survey !== undefined ? body.survey : row.survey_id,
        availableAt: body.availableAt ?? new Date(row.available_at).toISOString(),
        expiresAt: body.expiresAt !== undefined ? body.expiresAt : row.expires_at ? new Date(row.expires_at).toISOString() : null,
      };
      const r = checkBuild(row.id, merged, { betaIds: new Set(app.cfg.byId.keys()), surveys: app.cfg.surveys, ownHost: app.host });
      if (r.error) return fail(400, r.error);
      const b = r.build;
      await db
        .prepare("UPDATE builds SET label = ?, platform = ?, notes = ?, target = ?, groups = ?, survey_id = ?, available_at = ?, expires_at = ? WHERE id = ?")
        .bind(b.label, b.platform, b.notes, b.target, b.groups ? b.groups.join(",") : null, b.survey, b.availableAt ?? row.available_at, b.expiresAt, row.id)
        .run();
      return json({ ok: true, build: b });
    }
    if (m === "POST" && g[2]) {
      if (row.source !== "github") return fail(400, "Only github builds have an asset id.");
      const r = await resolveAsset(app.env, row.target);
      if (r.error) return fail(502, r.error);
      await db.prepare("UPDATE builds SET asset_id = ? WHERE id = ?").bind(r.id, row.id).run();
      return json({ ok: true, asset_id: r.id });
    }
  }

  if (m === "GET" && path === "downloads") {
    const where = [];
    const params = [];
    for (const [k, col] of [["build", "d.build_id"], ["tester", "d.tester_id"], ["beta", "t.beta_id"]]) {
      if (q.get(k)) {
        where.push(`${col} = ?`);
        params.push(q.get(k));
      }
    }
    const rows = (
      await db
        .prepare(`SELECT d.id, d.tester_id, d.build_id, d.at, d.source, d.result, d.colo, t.reader_code FROM downloads d LEFT JOIN testers t ON t.id = d.tester_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY d.at DESC LIMIT ?`)
        .bind(...params, lim(q.get("limit"), 200, 1000))
        .all()
    ).results;
    return json({ downloads: rows });
  }
  if (m === "GET" && path === "feedback") {
    const rows = q.get("survey")
      ? (await db.prepare("SELECT * FROM responses WHERE survey_id = ? ORDER BY updated_at DESC LIMIT 1000").bind(q.get("survey")).all()).results
      : (await db.prepare("SELECT * FROM responses ORDER BY updated_at DESC LIMIT 1000").all()).results;
    for (const r of rows) r.answers = JSON.parse(r.answers);
    return json({ responses: rows });
  }
  if (m === "GET" && path === "bugs") {
    const where = [];
    const params = [];
    if (q.get("beta")) {
      where.push("beta_id = ?");
      params.push(q.get("beta"));
    }
    if (q.get("status")) {
      where.push("status = ?");
      params.push(q.get("status"));
    }
    const rows = (await db.prepare(`SELECT id, tester_id, beta_id, build_id, title, body, severity, platform, status, images, images_note, created_at FROM bugs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT 500`).bind(...params).all()).results;
    return json({ bugs: rows });
  }
  if ((g = /^bugs\/(bug_[a-z0-9]{16})\/images\/([12])$/.exec(path)) && m === "GET") {
    const img = await db.prepare("SELECT mime, size, data, r2_key FROM bug_images WHERE bug_id = ? AND n = ?").bind(g[1], Number(g[2])).first();
    if (!img) return fail(404, "No such image.");
    let bytes = img.data;
    if (!bytes && img.r2_key && app.env.FILES) {
      const o = await app.env.FILES.get(img.r2_key);
      bytes = o ? await o.arrayBuffer() : null;
    }
    if (!bytes) return fail(404, "No such image.");
    const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[img.mime] ?? "bin";
    return new Response(bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": img.mime,
        "Content-Disposition": `attachment; filename="${g[1]}-${g[2]}.${ext}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Cache-Control": "private, no-store",
      },
    });
  }

  if (m === "GET" && path === "dashboard") return json(await dashboard(app, q.get("beta")));
  if (m === "GET" && path === "acceptances") {
    const rows = q.get("beta")
      ? (await db.prepare("SELECT * FROM acceptances WHERE beta_id = ? ORDER BY accepted_at DESC LIMIT 2000").bind(q.get("beta")).all()).results
      : (await db.prepare("SELECT * FROM acceptances ORDER BY accepted_at DESC LIMIT 2000").all()).results;
    return json({ acceptances: rows });
  }

  if (m === "GET" && path === "deliveries") {
    const rows = q.get("status")
      ? (await db.prepare("SELECT id, kind, tester_id, beta_id, ref, priority, status, attempts, next_at, not_before_day, last_error, created_at, sent_at FROM deliveries WHERE status = ? ORDER BY created_at DESC LIMIT 500").bind(q.get("status")).all()).results
      : (await db.prepare("SELECT id, kind, tester_id, beta_id, ref, priority, status, attempts, next_at, not_before_day, last_error, created_at, sent_at FROM deliveries ORDER BY created_at DESC LIMIT 500").all()).results;
    return json({ deliveries: rows, queue: await queueReport(app, 0) });
  }
  if ((g = /^deliveries\/(d_[a-z0-9]{16,20})\/retry$/.exec(path)) && m === "POST") {
    const r = await db.prepare("UPDATE deliveries SET status = 'pending', next_at = ?, not_before_day = NULL WHERE id = ? AND status IN ('failed','retry')").bind(app.now, g[1]).run();
    if (r.meta.changes) app.waitUntil(clockStub(app.env).wake().catch(() => {}));
    return json({ ok: true, retried: r.meta.changes > 0 });
  }
  if (m === "POST" && path === "test-email") {
    const to = normEmail(body.to ?? app.env.OWNER_EMAIL);
    if (!to) return fail(400, "to: an address (defaults to OWNER_EMAIL).");
    return json(await clockStub(app.env).testEmail(to, app.now));
  }

  if (m === "GET" && path === "footprint") return json(await footprint(app));
  if (m === "POST" && path === "housekeeping") return json({ ok: true, run: await clockStub(app.env).run() });

  return fail(404, "No such endpoint.");
}

/** "150 invites: sent over 2 days" (docs/SDD.md, "Email"). */
async function queueReport(app, adding) {
  const kinds = [...EMAIL_KINDS];
  const row = await app.db
    .prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE status IN ('pending','retry','sending') AND kind IN (${kinds.map(() => "?").join(",")})`)
    .bind(...kinds)
    .first();
  const st = await clockStub(app.env).emailStatus(app.now);
  const queued = row?.n ?? 0;
  const ahead = Math.max(0, queued - adding);
  const sentToday = st.day === utcDay(app.now) ? st.dayCount : 0;
  const days = daysToSend(adding, ahead, sentToday, st.caps.dailyCap);
  return {
    queued,
    sent_today: sentToday,
    daily_cap: st.caps.dailyCap,
    days,
    summary: adding ? `${adding} invite${adding === 1 ? "" : "s"}: sent ${days === 1 ? "today" : `over ${days} days`}` : `Queued: ${queued}${st.left <= 0 && queued ? ", sending from 00:00 UTC" : ""}`,
  };
}

async function dashboard(app, betaId) {
  const db = app.db;
  const betas = betaId ? [betaId] : [...app.cfg.byId.keys()];
  const out = [];
  for (const id of betas) {
    if (!app.cfg.byId.has(id)) continue;
    const res = await db.batch([
      db.prepare("SELECT status, COUNT(*) AS n FROM testers WHERE beta_id = ? GROUP BY status").bind(id),
      db.prepare(
        `SELECT b.id, b.label, b.source,
           (SELECT COUNT(*) FROM downloads d WHERE d.build_id = b.id AND d.result = 'started') AS downloads,
           (SELECT COUNT(DISTINCT d.tester_id) FROM downloads d WHERE d.build_id = b.id AND d.result = 'started') AS testers,
           (SELECT COUNT(*) FROM responses r WHERE r.build_id = b.id) AS responses,
           (SELECT COUNT(*) FROM bugs g WHERE g.build_id = b.id) AS bugs
         FROM builds b WHERE b.beta_id = ? ORDER BY b.available_at DESC`,
      ).bind(id),
      db.prepare("SELECT t.id, t.name, t.reader_code FROM testers t WHERE t.beta_id = ? AND t.status = 'active' AND NOT EXISTS (SELECT 1 FROM downloads d WHERE d.tester_id = t.id AND d.result = 'started') LIMIT 500").bind(id),
      db.prepare(
        `SELECT t.id, t.name, t.reader_code FROM testers t WHERE t.beta_id = ? AND t.status = 'active' AND EXISTS (SELECT 1 FROM downloads d WHERE d.tester_id = t.id AND d.result = 'started')
           AND NOT EXISTS (SELECT 1 FROM responses r WHERE r.tester_id = t.id) AND NOT EXISTS (SELECT 1 FROM bugs g WHERE g.tester_id = t.id) LIMIT 500`,
      ).bind(id),
      db.prepare("SELECT COALESCE(src, '(none)') AS src, COUNT(*) AS applications, SUM(CASE WHEN status IN ('approved','invited','active') THEN 1 ELSE 0 END) AS approved FROM testers WHERE beta_id = ? GROUP BY src").bind(id),
      db.prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM bug_images"),
    ]);
    const c = Object.fromEntries(res[0].results.map((r) => [r.status, r.n]));
    out.push({
      beta: id,
      applicants: (c.applied ?? 0) + (c.waitlisted ?? 0),
      invited: (c.approved ?? 0) + (c.invited ?? 0),
      active: c.active ?? 0,
      revoked: c.revoked ?? 0,
      statuses: c,
      claimed: c.active ?? 0,
      builds: res[1].results,
      not_downloaded: res[2].results,
      downloaded_no_feedback: res[3].results,
      by_source: res[4].results,
      screenshots: { bytes: res[5].results[0].bytes, cap: app.cfg.screenshots.totalCap },
      downloads_note: "downloads started (a redirect ends the Worker's view)",
    });
  }
  return { betas: out };
}

async function footprint(app) {
  const db = app.db;
  const since = Date.parse(`${utcDay(app.now)}T00:00:00Z`);
  // Rows created today, and the index rows each insert also writes (as perchlight-hooks assumes).
  const tables = [
    ["testers", "applied_at", 3],
    ["events", "at", 2],
    ["downloads", "at", 3],
    ["responses", "updated_at", 1],
    ["bugs", "created_at", 2],
    ["deliveries", "created_at", 3],
    ["acceptances", "accepted_at", 2],
    ["signins", "created_at", 2],
    ["invites", "created_at", 2],
  ];
  const res = await db.batch([
    ...tables.map(([t, col]) => db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} >= ?`).bind(since)),
    db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM rate WHERE window_start >= ?").bind(since - 86_400_000),
    db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE sent_at >= ?").bind(since),
  ]);
  const rows = {};
  let written = 0;
  tables.forEach(([t, , idx], i) => {
    const n = res[i].results[0].n;
    rows[t] = n;
    written += n * (1 + idx);
  });
  const rateRows = Math.min(res[tables.length].results[0].n, 5000);
  written += rateRows * 2;
  const sentUpdates = res[tables.length + 1].results[0].n;
  written += sentUpdates * 3;
  const clock = await clockStub(app.env).status();
  return {
    day: utcDay(app.now),
    d1: { rows_created: rows, rate_hits: rateRows, est_rows_written: written, limit: 100_000 },
    clock: { runs: clock.footprint.runs, do_requests_est: clock.footprint.runs, do_rows_written: clock.footprint.doRowsWritten, subrequests: clock.footprint.subrequests, emails: clock.footprint.emails, last_run_at: clock.lastRunAt, last_error: clock.lastError, alarm_at: clock.alarmAt },
    previous_days: clock.previous,
    estimate: estimate(app),
    limits: { worker_requests: 100_000, d1_rows_written: 100_000, d1_rows_read: 5_000_000, do_requests: 100_000, emails_per_day: app.cfg.email.dailyCap, emails_per_month: app.cfg.email.monthlyCap },
  };
}
