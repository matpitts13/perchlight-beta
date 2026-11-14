// Clock: one Durable Object instance ("clock"), one alarm, NO cron trigger
// (docs/SDD.md, "Clock"). Built the same way as perchlight-hooks' Scheduler.
//
// One run:
// 1. SETS THE NEXT ALARM FIRST (5 minutes ahead), before anything can fail.
// 2. Syncs beta.json into D1 when it changed; applies the desktop app's
//    pending actions (action_requested on testers, bugs, deliveries).
// 3. Sends due tester email under the daily and monthly caps (counted in its
//    own SQLite, claimed before sending) and the subrequest budget (45 of 50;
//    at most 30 emails a run), in priority order: sign-in links, invites,
//    new-build notices, reminders. One perchlight-keys call.
// 4. Queues reminders (one INSERT … SELECT per kind; each has a unique dedupe
//    key, so a reminder is queued once however often the alarm runs).
// 5. Expires invites; retention (hourly, bounded deletes); owner notices
//    (send_email, grouped, at most every 30 minutes).
// 6. Writes its hot state to SQLite (one row) EVERY run. Persistent failures
//    back off (5, 10, 20, 40, 60 minutes); they never hot-loop.
import { DurableObject } from "cloudflare:workers";
import { EmailMessage } from "cloudflare:email";
import { makeApp, testHooks, termsSha } from "./lib/appctx.js";
import { newBudget, spend, MAX_EMAILS_PER_RUN } from "./lib/budget.js";
import { compose } from "./lib/emails.js";
import { getSender } from "./lib/mail/index.js";
import { capLeft, addCount, nextRetryAt, tomorrow, EMAIL_KINDS, STALE_CLAIM_MS, PRIORITY } from "./lib/queue.js";
import { linkToken, sha256Hex, randomId } from "./lib/crypto.js";
import { utcDay, utcMonth } from "./lib/http.js";
import { decide, deleteTesters } from "./lib/testers.js";
import { issueKey, revokeKey, keysTransport } from "./lib/keys.js";
import { mime, addressOnly, redactAddresses } from "./lib/mime.js";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const IDLE_MS = 5 * MIN;
export const MAX_BACKOFF_MS = HOUR;
export const NOTICE_MS = 30 * MIN;
export const HOUSEKEEPING_MS = HOUR;
const DELETE_LIMIT = 100;
export const SYNC_CHUNK = 20;
const SEND_CONCURRENCY = 5;
const errText = (err) => (err instanceof Error ? err.message : String(err));
const newId = (p) => `'${p}_' || lower(hex(randomblob(10)))`;

function emptyFootprint(day) {
  return { day, runs: 0, subrequests: 0, d1Calls: 0, emails: 0, keysCalls: 0, notices: 0, doRowsWritten: 0 };
}

function defaultHot(now) {
  return { lastRunAt: null, lastError: null, failures: 0, cfgHash: null, noticeAt: 0, noticeCursor: now, housekeepingAt: 0, fp: emptyFootprint(utcDay(now)), fpPrev: [] };
}

/** Counts every D1 call against the run's budget (a batch is one subrequest). */
function countingDb(db, budget, fp) {
  const tick = () => {
    budget.left--;
    budget.used++;
    fp.d1Calls++;
  };
  const wrap = (s) => ({
    _inner: s,
    bind: (...a) => wrap(s.bind(...a)),
    first: (...a) => (tick(), s.first(...a)),
    all: (...a) => (tick(), s.all(...a)),
    run: (...a) => (tick(), s.run(...a)),
    raw: (...a) => (tick(), s.raw(...a)),
  });
  return { prepare: (q) => wrap(db.prepare(q)), batch: (stmts) => (tick(), db.batch(stmts.map((x) => x._inner ?? x))) };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

/** The CTE "cfg(beta_id, days)" for per-beta day thresholds, or null when none apply. */
function cfgValues(pairs) {
  if (!pairs.length) return null;
  return { sql: `WITH cfg(beta_id, days) AS (VALUES ${pairs.map(() => "(?, ?)").join(", ")})`, params: pairs.flat() };
}

export function clockClass(rawConfig, terms = {}) {
  return class Clock extends DurableObject {
    constructor(ctx, env) {
      super(ctx, env);
      Object.defineProperty(this, "env", { get: () => (testHooks.env ? { ...env, ...testHooks.env } : env) });
      this.sql = ctx.storage.sql;
      this.sql.exec("CREATE TABLE IF NOT EXISTS run (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
      this.sql.exec("CREATE TABLE IF NOT EXISTS email_counts (period TEXT PRIMARY KEY, n INTEGER NOT NULL)");
      this.hot = null;
    }

    load(now) {
      if (!this.hot) {
        const r = this.sql.exec("SELECT v FROM run WHERE k = 'hot'").toArray()[0];
        this.hot = { ...defaultHot(now), ...(r ? JSON.parse(r.v) : {}) };
      }
      const day = utcDay(now);
      if (this.hot.fp.day !== day) {
        this.hot.fpPrev = [this.hot.fp, ...(this.hot.fpPrev ?? [])].slice(0, 7);
        this.hot.fp = emptyFootprint(day);
      }
      return this.hot;
    }

    /** The whole hot state, one row, every run. */
    persist() {
      this.hot.fp.doRowsWritten++;
      this.sql.exec("INSERT INTO run (k, v) VALUES ('hot', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", JSON.stringify(this.hot));
    }

    counts(now) {
      const day = `d:${utcDay(now)}`;
      const month = `m:${utcMonth(now)}`;
      const get = (k) => this.sql.exec("SELECT n FROM email_counts WHERE period = ?", k).toArray()[0]?.n ?? 0;
      return { day: utcDay(now), dayCount: get(day), month: utcMonth(now), monthCount: get(month) };
    }

    /** Adds n (may be negative) to today's and this month's counts. */
    bump(now, n) {
      if (!n) return;
      for (const k of [`d:${utcDay(now)}`, `m:${utcMonth(now)}`]) {
        this.sql.exec("INSERT INTO email_counts (period, n) VALUES (?, ?) ON CONFLICT (period) DO UPDATE SET n = MAX(0, n + excluded.n)", k, n);
      }
      if (this.hot) this.hot.fp.doRowsWritten += 2;
      // Old periods go (keep ~3 months).
      this.sql.exec("DELETE FROM email_counts WHERE (period LIKE 'd:%' AND period < ?) OR (period LIKE 'm:%' AND period < ?)", `d:${utcDay(now - 40 * DAY)}`, `m:${utcMonth(now - 100 * DAY)}`);
    }

    async setAlarmAt(t) {
      await this.ctx.storage.setAlarm(t);
      this.alarmAt = t;
    }

    // ---- RPC from the Worker ----

    /** Re-arms the alarm if it's missing or the last run is over 10 minutes old. */
    async ensureAlarm(nowArg) {
      const now = nowArg ?? Date.now();
      const h = this.load(now);
      const cur = await this.ctx.storage.getAlarm();
      const stale = h.lastRunAt === null || now - h.lastRunAt > 10 * MIN;
      if (cur === null || cur < now - MIN || (stale && cur > now + IDLE_MS + MAX_BACKOFF_MS)) {
        await this.setAlarmAt(now + 1000);
        return { rearmed: true };
      }
      return { rearmed: false };
    }

    /** Asks for a run soon (a sign-in link or invite is waiting). */
    async wake() {
      const t = Date.now() + 1000;
      this.wakeAt = Math.min(this.wakeAt ?? Infinity, t);
      const cur = await this.ctx.storage.getAlarm();
      if (cur === null || cur > t + 1000) await this.setAlarmAt(t);
      return { at: t };
    }

    async emailStatus(nowArg) {
      const now = nowArg ?? Date.now();
      const app = makeApp(rawConfig, terms, this.env, { now: () => now });
      return { ...this.counts(now), caps: app.cfg.email, left: capLeft(this.counts(now), app.cfg.email, now) };
    }

    async status() {
      const h = this.load(Date.now());
      return { lastRunAt: h.lastRunAt, lastError: h.lastError, failures: h.failures, alarmAt: await this.ctx.storage.getAlarm(), footprint: h.fp, previous: h.fpPrev };
    }

    /** POST /api/test-email: one email to `to`, under the cap. */
    async testEmail(to, nowArg) {
      const now = nowArg ?? Date.now();
      const app = makeApp(rawConfig, terms, this.env, { now: () => now });
      if (capLeft(this.counts(now), app.cfg.email, now) < 1) return { status: "throttled", error: "today's email cap is used up" };
      const sender = getSender(this.env);
      if (!sender) return { status: "config", error: "set MAIL_FROM and RESEND_API_KEY" };
      this.bump(now, 1);
      const r = await sender.send({ to, subject: "perchlight-beta test email", text: "This is a test email from perchlight-beta.", html: "<p>This is a test email from perchlight-beta.</p>" }, { idempotencyKey: `beta-test-${randomId("x")}` });
      if (r.status !== "sent" && r.status !== "unknown") this.bump(now, -1);
      return r;
    }

    async alarm() {
      if (this.env.PAUSE_ALARMS === "1") return; // tests drive runs directly
      await this.run(Date.now());
    }

    /** One run at `now`. Runs never overlap (an RPC run and the alarm would both read the cap). */
    async run(now = Date.now()) {
      if (this.running) return { skipped: true, reason: "a run is already in progress" };
      this.running = true;
      try {
        return await this.runOnce(now);
      } finally {
        this.running = false;
      }
    }

    async runOnce(now) {
      const h = this.load(now);
      this.wakeAt = undefined;
      await this.setAlarmAt(now + IDLE_MS);
      const budget = newBudget();
      const app = makeApp(rawConfig, terms, this.env, { now: () => now });
      const realDb = app.db;
      app.db = countingDb(realDb, budget, h.fp);
      const out = { synced: false, actions: 0, sent: 0, keys: 0, reminders: 0, expired: 0, deleted: 0, notice: false, leftover: false, error: null, subrequests: 0 };
      h.fp.runs++;
      // Each step is isolated: a failure in one (say a config sync D1 refuses) never starves the email queue.
      const errors = [];
      const step = async (name, fn) => {
        try {
          await fn();
        } catch (err) {
          errors.push(`${name}: ${errText(err)}`);
        }
      };
      if (!realDb) errors.push("the DB binding is missing");
      else {
        await step("sync", () => this.syncConfig(app, h, out));
        await step("actions", () => this.applyActions(app, out, budget));
        await step("email", () => this.sendDue(app, out, budget));
        await step("keys", () => this.keysWork(app, out, budget));
        if (budget.left >= 6) await step("reminders", () => this.reminders(app, out));
        if (budget.left >= 5) await step("housekeeping", () => this.housekeeping(app, h, out, budget));
        if (budget.left >= 3) await step("notice", () => this.ownerNotice(app, h, out, budget));
      }
      if (errors.length) {
        h.failures = (h.failures ?? 0) + 1;
        h.lastError = errors.join("; ").slice(0, 300);
        out.error = h.lastError;
        out.leftover = false;
        console.error(`clock run: ${h.lastError}`);
      } else {
        h.failures = 0;
        h.lastError = null;
      }
      h.lastRunAt = now;
      h.fp.subrequests += budget.used;
      out.subrequests = budget.used;
      let next = now + IDLE_MS;
      if (h.failures > 0) next = now + Math.min(IDLE_MS * 2 ** Math.min(h.failures - 1, 4), MAX_BACKOFF_MS);
      else if (out.leftover) next = now + 2000;
      if (this.wakeAt && this.wakeAt < next) next = Math.max(this.wakeAt, now + 1000);
      try {
        this.persist();
      } catch (err) {
        console.error(`clock persist: ${errText(err)}`);
      }
      if (next !== this.alarmAt) await this.setAlarmAt(next);
      out.nextAt = next;
      return out;
    }

    // ---- 2. config sync and app actions ----

    async syncConfig(app, h, out) {
      const cfg = app.cfg;
      const parts = [JSON.stringify(rawConfig), ...Object.entries(terms).map(([k, v]) => `${k}:${v.length}`)];
      const shas = await Promise.all(cfg.betas.filter((b) => !b.error).map((b) => termsSha(b)));
      const hash = await sha256Hex(parts.join("|") + shas.join(","));
      if (h.cfgHash === hash) return;
      const now = app.now;
      const stmts = [];
      for (const b of cfg.betas) {
        const ok = !b.error;
        stmts.push(
          app.db
            .prepare(
              `INSERT INTO betas (id, name, type, status, terms_version, terms_sha256, max_testers, ends_at, config_error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (id) DO UPDATE SET name = excluded.name, type = excluded.type, status = CASE WHEN betas.closed_at IS NOT NULL THEN 'closed' ELSE excluded.status END,
               terms_version = excluded.terms_version, terms_sha256 = excluded.terms_sha256, max_testers = excluded.max_testers, ends_at = excluded.ends_at, config_error = excluded.config_error, updated_at = excluded.updated_at`,
            )
            .bind(b.id, b.name ?? b.id, ok ? b.type : "game", ok ? b.status : "draft", ok ? b.terms.version : null, ok ? await termsSha(b) : null, ok ? b.maxTesters : null, ok ? b.endsAt : null, b.error ?? null, now),
        );
      }
      for (const b of cfg.builds) {
        if (!b.beta) continue;
        stmts.push(
          app.db
            .prepare(
              `INSERT INTO builds (id, beta_id, label, platform, notes, source, target, mark_manifest, groups, survey_id, available_at, expires_at, origin, config_error, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'config', ?, ?)
               ON CONFLICT (id) DO UPDATE SET beta_id = excluded.beta_id, label = excluded.label, platform = excluded.platform, notes = excluded.notes, source = excluded.source,
               asset_id = CASE WHEN builds.target = excluded.target THEN builds.asset_id ELSE NULL END, target = excluded.target, mark_manifest = excluded.mark_manifest, groups = excluded.groups,
               survey_id = excluded.survey_id, available_at = excluded.available_at, expires_at = excluded.expires_at, config_error = excluded.config_error
               WHERE builds.origin = 'config'`,
            )
            .bind(
              b.id,
              b.beta,
              b.label ?? b.id,
              b.platform ?? null,
              b.notes ?? null,
              b.source ?? "link",
              b.target ?? "",
              b.mark ?? null,
              b.groups ? b.groups.join(",") : null,
              b.survey ?? null,
              b.availableAt ?? now,
              b.expiresAt ?? null,
              b.error ?? null,
              now,
            ),
        );
      }
      // Config builds removed from beta.json are switched off, not deleted (their download log stays).
      const ids = cfg.builds.map((b) => b.id);
      stmts.push(
        app.db
          .prepare("UPDATE builds SET config_error = 'removed from beta.json' WHERE origin = 'config' AND id NOT IN (SELECT value FROM json_each(?))")
          .bind(JSON.stringify(ids)),
      );
      // At most SYNC_CHUNK statements a run (D1 statements per invocation are limited); the rest follow 2 s later.
      if (h.syncHash !== hash) {
        h.syncHash = hash;
        h.syncCursor = 0;
      }
      const from = h.syncCursor ?? 0;
      await app.db.batch(stmts.slice(from, from + SYNC_CHUNK));
      if (from + SYNC_CHUNK >= stmts.length) {
        h.cfgHash = hash;
        h.syncCursor = 0;
        out.synced = true;
      } else {
        h.syncCursor = from + SYNC_CHUNK;
        out.leftover = true;
      }
    }

    async applyActions(app, out, budget) {
      const res = await app.db.batch([
        app.db.prepare("SELECT id, action_requested FROM testers WHERE action_requested IS NOT NULL LIMIT 200"),
        app.db.prepare("SELECT id, action_requested FROM bugs WHERE action_requested IS NOT NULL LIMIT 200"),
        app.db.prepare("SELECT id FROM deliveries WHERE action_requested IS NOT NULL LIMIT 200"),
      ]);
      const [testers, bugs, dels] = res.map((r) => r.results);
      const byAction = new Map();
      for (const t of testers) byAction.set(t.action_requested, [...(byAction.get(t.action_requested) ?? []), t.id]);
      for (const [action, ids] of byAction) {
        if (budget.left < 12) break;
        if (["approve", "decline", "waitlist", "block", "revoke", "resend_invite"].includes(action)) await decide(app, ids, action);
        else await app.db.prepare("UPDATE testers SET action_requested = NULL WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).run();
        out.actions += ids.length;
      }
      const stmts = [];
      if (bugs.length) {
        // One statement for all of them: the new status is the requested one when it's valid.
        stmts.push(
          app.db
            .prepare(
              "UPDATE bugs SET status = CASE WHEN action_requested IN ('new','triaged','fixed','wontfix','duplicate') THEN action_requested ELSE status END, action_requested = NULL WHERE id IN (SELECT value FROM json_each(?))",
            )
            .bind(JSON.stringify(bugs.map((b) => b.id))),
        );
      }
      if (dels.length) {
        stmts.push(
          app.db
            .prepare(
              "UPDATE deliveries SET status = CASE WHEN status IN ('failed','retry') THEN 'pending' ELSE status END, next_at = ?, not_before_day = NULL, action_requested = NULL WHERE id IN (SELECT value FROM json_each(?))",
            )
            .bind(app.now, JSON.stringify(dels.map((d) => d.id))),
        );
      }
      if (stmts.length) await app.db.batch(stmts);
      out.actions += bugs.length + dels.length;
    }

    // ---- 3. email ----

    async sendDue(app, out, budget) {
      const now = app.now;
      const today = utcDay(now);
      const caps = app.cfg.email;
      const counts = this.counts(now);
      const left = capLeft(counts, caps, now);
      // Sign-in links may also use a small reserve above the cap (they expire in 30 minutes, so
      // they're never postponed to tomorrow); everything else stops at the cap.
      const r = app.cfg.email.signinReserve;
      const leftSignin = capLeft(counts, { dailyCap: caps.dailyCap + r, monthlyCap: caps.monthlyCap + r }, now);
      const kinds = [...EMAIL_KINDS];
      const km = kinds.map(() => "?").join(",");
      const later = kinds.filter((k) => k !== "signin");
      const lm = later.map(() => "?").join(",");
      // Room in this run: the caps, 30 emails, and the budget less what the later steps need.
      const room = Math.min(Math.max(left, leftSignin), MAX_EMAILS_PER_RUN, budget.left - 12);
      const res = await app.db.batch([
        // Interrupted claims are retried (same Resend idempotency key, safe).
        app.db.prepare(`UPDATE deliveries SET status = 'retry', next_at = ? WHERE status = 'sending' AND claimed_at < ? AND kind IN (${km})`).bind(now, now - STALE_CLAIM_MS, ...kinds),
        // A full cap: what's due (except sign-in links) waits for the next UTC day (shown in the app).
        left <= 0
          ? app.db
              .prepare(`UPDATE deliveries SET not_before_day = ? WHERE status IN ('pending','retry') AND kind IN (${lm}) AND (not_before_day IS NULL OR not_before_day <= ?)`)
              .bind(tomorrow(now), ...later, today)
          : app.db.prepare("SELECT 1"),
        app.db
          .prepare(
            `SELECT d.id, d.kind, d.ref, d.attempts, d.beta_id, t.id AS tid, t.email, t.name, t.status AS tstatus, t.reminders_off,
               i.status AS istatus, i.expires_at AS iexpires, s.used_at AS sused, s.expires_at AS sexpires, b.label AS blabel
             FROM deliveries d LEFT JOIN testers t ON t.id = d.tester_id LEFT JOIN invites i ON i.id = d.ref LEFT JOIN signins s ON s.id = d.ref LEFT JOIN builds b ON b.id = d.ref
             WHERE d.status IN ('pending','retry') AND d.kind IN (${left > 0 ? km : "'signin'"}) AND d.next_at <= ? AND (d.not_before_day IS NULL OR d.not_before_day <= ?)
             ORDER BY d.priority, d.created_at LIMIT ?`,
          )
          .bind(...(left > 0 ? kinds : []), now, today, Math.max(0, room) + 1),
      ]);
      if (room <= 0) return;
      // Sign-ins first (priority order), then the rest while the plain cap allows.
      let due = [];
      let others = 0;
      for (const d of res[2].results) {
        if (due.length >= room) break;
        if (d.kind !== "signin") {
          if (others >= left) continue;
          others++;
        }
        due.push(d);
      }
      const more = res[2].results.length > room && due.length >= room;
      if (!due.length) return;
      const sender = getSender(this.env);
      if (!sender) return; // email isn't set up: deliveries wait (the config check says so); no fast follow-up run

      const valid = [];
      const dropped = [];
      for (const d of due) {
        const why = this.invalid(app, d, now);
        if (why) dropped.push({ d, why });
        else valid.push(d);
      }
      const stmts = [];
      for (const { d, why } of dropped) stmts.push(app.db.prepare("UPDATE deliveries SET status = 'failed', last_error = ? WHERE id = ?").bind(`dropped: ${why}`, d.id));
      let claimed = [];
      if (valid.length) {
        const m = valid.map(() => "?").join(",");
        stmts.push(app.db.prepare(`UPDATE deliveries SET status = 'sending', attempts = attempts + 1, claimed_at = ? WHERE id IN (${m}) AND status IN ('pending','retry') RETURNING id`).bind(now, ...valid.map((d) => d.id)));
        // Invites: the token's hash is stored before the send (the token itself is only in the email).
        for (const d of valid.filter((x) => x.kind === "invite")) {
          const hash = await sha256Hex(await linkToken(app.env.LINK_SECRET || "", "invite", d.ref));
          stmts.push(app.db.prepare("UPDATE invites SET token_hash = ? WHERE id = ? AND status = 'queued'").bind(hash, d.ref));
        }
      }
      if (stmts.length) {
        const r = await app.db.batch(stmts);
        if (valid.length) {
          const ids = new Set(r[dropped.length].results.map((x) => x.id));
          claimed = valid.filter((d) => ids.has(d.id));
        }
      }
      if (!claimed.length) return;
      // Claimed before sending: the counts go up first, so a crash can't exceed the cap.
      this.bump(now, claimed.length);
      spend(budget, claimed.length); // one Resend request each
      out.leftover = out.leftover || more;
      let stop = null; // "throttled" | "config": the rest of this run isn't sent
      const results = await pool(claimed, SEND_CONCURRENCY, async (d) => {
        if (stop) return { d, r: { status: "skipped" } };
        const msg = await this.message(app, d);
        const r = await sender.send({ to: d.email, ...msg }, { idempotencyKey: `beta-${d.id}` });
        if (r.status === "throttled" || r.status === "config") stop = stop ?? r.status;
        return { d, r };
      });
      const done = [];
      let notSent = 0;
      let throttled = false;
      for (const { d, r } of results) {
        const attempts = d.attempts + 1;
        const err = r.error ? redactAddresses(r.error).slice(0, 300) : null;
        if (r.status === "sent" || r.status === "unknown") {
          if (r.status === "sent") {
            done.push(app.db.prepare("UPDATE deliveries SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?").bind(now, d.id));
            out.sent++;
          } else {
            const at = nextRetryAt(attempts, now);
            done.push(app.db.prepare("UPDATE deliveries SET status = ?, next_at = ?, last_error = ? WHERE id = ?").bind(at ? "retry" : "failed", at ?? now, err, d.id));
          }
          if (d.kind === "invite") {
            const beta = app.cfg.byId.get(d.beta_id);
            done.push(
              app.db.prepare("UPDATE invites SET status = 'sent', sent_at = COALESCE(sent_at, ?), expires_at = COALESCE(expires_at, ?) WHERE id = ? AND status IN ('queued','sent')").bind(now, now + beta.inviteDays * DAY, d.ref),
              app.db.prepare("UPDATE testers SET status = 'invited' WHERE id = ? AND status = 'approved'").bind(d.tid),
            );
          }
          h_emails(this, 1);
          continue;
        }
        notSent++;
        if (r.status === "skipped") {
          done.push(app.db.prepare("UPDATE deliveries SET status = 'pending', attempts = attempts - 1 WHERE id = ?").bind(d.id));
        } else if (r.status === "throttled" && d.kind === "signin") {
          throttled = true;
          done.push(app.db.prepare("UPDATE deliveries SET status = 'failed', last_error = ? WHERE id = ?").bind(err, d.id));
        } else if (r.status === "throttled") {
          throttled = true;
          done.push(app.db.prepare("UPDATE deliveries SET status = 'pending', attempts = attempts - 1, not_before_day = ?, last_error = ? WHERE id = ?").bind(tomorrow(now), err, d.id));
        } else if (r.status === "config") {
          done.push(app.db.prepare("UPDATE deliveries SET status = 'retry', attempts = attempts - 1, next_at = ?, last_error = ? WHERE id = ?").bind(now + HOUR, err, d.id));
        } else if (r.status === "retry") {
          const at = nextRetryAt(attempts, now);
          done.push(app.db.prepare("UPDATE deliveries SET status = ?, next_at = ?, last_error = ? WHERE id = ?").bind(at ? "retry" : "failed", at ?? now, err, d.id));
        } else {
          done.push(app.db.prepare("UPDATE deliveries SET status = 'failed', last_error = ? WHERE id = ?").bind(err, d.id));
        }
      }
      this.bump(now, -notSent);
      if (throttled) {
        // Resend says the quota is used up: nothing more today.
        const c = this.counts(now);
        this.bump(now, Math.max(0, caps.dailyCap - c.dayCount));
        out.leftover = false;
      }
      if (stop) out.leftover = false;
      if (done.length) await app.db.batch(done);
    }

    /** Why a due delivery shouldn't be sent any more, or null. */
    invalid(app, d, now) {
      const beta = app.cfg.byId.get(d.beta_id);
      if (!beta) return "beta switched off";
      if (!d.tid || !d.email) return "tester deleted";
      switch (d.kind) {
        case "signin":
          return d.tstatus === "active" && d.sused === null && d.sexpires > now ? null : "sign-in link used, expired or tester inactive";
        case "invite":
          return ["approved", "invited"].includes(d.tstatus) && ["queued", "sent"].includes(d.istatus) ? null : "invite revoked or tester decided";
        case "reminder_invite":
          return !d.reminders_off && d.tstatus === "invited" && d.istatus === "sent" && d.iexpires > now ? null : "invite claimed, expired or reminders off";
        case "new_build":
        case "reminder_survey":
        case "reminder_ending":
          return !d.reminders_off && d.tstatus === "active" ? null : "tester inactive or reminders off";
        default:
          return "unknown kind";
      }
    }

    async message(app, d) {
      const beta = app.cfg.byId.get(d.beta_id);
      const c = { beta, base: app.base, name: d.name };
      if (d.kind === "invite") {
        c.link = `${app.base}/i/${await linkToken(app.env.LINK_SECRET || "", "invite", d.ref)}`;
        c.days = beta.inviteDays;
      } else if (d.kind === "signin") {
        c.link = `${app.base}/s/${await linkToken(app.env.LINK_SECRET || "", "signin", d.ref)}`;
      }
      c.build = d.blabel ?? "A new build";
      c.endsAt = beta.endsAt;
      return compose(d.kind, c);
    }

    // ---- perchlight-keys: one call per run ----

    async keysWork(app, out, budget) {
      if (budget.left < 4 || keysTransport(app.env).error) return;
      const now = app.now;
      const d = await app.db
        .prepare(
          `SELECT d.id, d.kind, d.ref, d.attempts, d.beta_id, d.tester_id, t.email, t.name, t.status AS tstatus FROM deliveries d LEFT JOIN testers t ON t.id = d.tester_id
           WHERE d.kind IN ('key_issue','key_revoke') AND (d.status IN ('pending','retry') OR (d.status = 'sending' AND d.claimed_at < ?)) AND d.next_at <= ? ORDER BY d.created_at LIMIT 1`,
        )
        .bind(now - STALE_CLAIM_MS, now)
        .first();
      if (!d) return;
      const beta = app.cfg.byId.get(d.beta_id);
      if (d.kind === "key_issue" && (!beta?.keys || d.tstatus !== "active")) {
        await app.db.prepare("UPDATE deliveries SET status = 'failed', last_error = 'dropped: tester inactive or keys off' WHERE id = ?").bind(d.id).run();
        return;
      }
      const claim = await app.db.prepare("UPDATE deliveries SET status = 'sending', attempts = attempts + 1, claimed_at = ? WHERE id = ? AND status IN ('pending','retry','sending') RETURNING attempts").bind(now, d.id).first();
      if (!claim) return;
      spend(budget, 1);
      out.keys++;
      this.hot.fp.keysCalls++;
      const r = d.kind === "key_issue" ? await issueKey(app.env, { beta, tester: { id: d.tester_id, email: d.email, name: d.name } }) : await revokeKey(app.env, d.ref);
      const stmts = [];
      if (r.status === "ok") {
        stmts.push(app.db.prepare("UPDATE deliveries SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?").bind(now, d.id));
        if (d.kind === "key_issue") {
          stmts.push(
            app.db.prepare("UPDATE testers SET license_id = ?, key_status = 'issued' WHERE id = ? AND status = 'active'").bind(r.licenseId, d.tester_id),
            // Revoked or deleted while the call was out: revoke the new key at once.
            app.db
              .prepare(
                `INSERT INTO deliveries (id, kind, tester_id, beta_id, ref, dedupe, priority, status, attempts, next_at, created_at)
                 SELECT ?, 'key_revoke', NULL, ?, ?, 'key_revoke:' || ?, ${PRIORITY.key_revoke}, 'pending', 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM testers WHERE id = ? AND status = 'active')
                 ON CONFLICT (dedupe) DO NOTHING`,
              )
              .bind(randomId("d"), d.beta_id, r.licenseId, r.licenseId, now, now, d.tester_id),
          );
        } else {
          stmts.push(app.db.prepare("UPDATE testers SET key_status = 'revoked' WHERE license_id = ?").bind(d.ref));
        }
      } else {
        const at = r.status === "rejected" ? null : nextRetryAt(claim.attempts, now);
        stmts.push(app.db.prepare("UPDATE deliveries SET status = ?, next_at = ?, last_error = ? WHERE id = ?").bind(at ? "retry" : "failed", at ?? now, String(r.error ?? r.status).slice(0, 300), d.id));
        if (!at && d.kind === "key_issue") stmts.push(app.db.prepare("UPDATE testers SET key_status = 'failed' WHERE id = ?").bind(d.tester_id));
      }
      await app.db.batch(stmts);
    }

    // ---- 4. reminders ----

    async reminders(app, out) {
      const now = app.now;
      const betas = app.cfg.betas.filter((b) => !b.error);
      const stmts = [];
      const insert = `INSERT INTO deliveries (id, kind, tester_id, beta_id, ref, dedupe, priority, status, attempts, next_at, created_at)`;
      const inv = cfgValues(betas.filter((b) => b.reminders.unclaimedInvite > 0).map((b) => [b.id, b.reminders.unclaimedInvite]));
      if (inv) {
        stmts.push(
          app.db
            .prepare(
              `${inv.sql} ${insert}
               SELECT ${newId("d")}, 'reminder_invite', t.id, t.beta_id, i.id, 'reminder_invite:' || i.id, ${PRIORITY.reminder_invite}, 'pending', 0, ?, ?
               FROM invites i JOIN testers t ON t.id = i.tester_id JOIN cfg ON cfg.beta_id = t.beta_id
               WHERE i.status = 'sent' AND i.sent_at <= ? - cfg.days * ${DAY} AND i.expires_at > ? AND t.status = 'invited' AND t.reminders_off = 0
               ON CONFLICT (dedupe) DO NOTHING`,
            )
            .bind(...inv.params, now, now, now, now),
        );
      }
      const nb = betas.filter((b) => b.reminders.newBuild).map((b) => b.id);
      if (nb.length) {
        stmts.push(
          app.db
            .prepare(
              `${insert}
               SELECT ${newId("d")}, 'new_build', t.id, t.beta_id, b.id, 'new_build:' || b.id || ':' || t.id, ${PRIORITY.new_build}, 'pending', 0, ?, ?
               FROM builds b JOIN testers t ON t.beta_id = b.beta_id
               WHERE b.announced = 0 AND b.config_error IS NULL AND b.available_at <= ? AND (b.expires_at IS NULL OR b.expires_at > ?) AND b.beta_id IN (${nb.map(() => "?").join(",")})
                 AND t.status = 'active' AND t.reminders_off = 0
                 AND (b.groups IS NULL OR EXISTS (SELECT 1 FROM json_each('["' || replace(b.groups, ',', '","') || '"]') g WHERE instr(',' || COALESCE(t.groups, '') || ',', ',' || g.value || ',') > 0))
               ON CONFLICT (dedupe) DO NOTHING`,
            )
            .bind(now, now, now, now, ...nb),
        );
      }
      const announceAt = stmts.length;
      stmts.push(app.db.prepare("UPDATE builds SET announced = 1 WHERE announced = 0 AND available_at <= ?").bind(now));
      const sv = cfgValues(betas.filter((b) => b.reminders.surveyNudge > 0).map((b) => [b.id, b.reminders.surveyNudge]));
      if (sv) {
        stmts.push(
          app.db
            .prepare(
              `${sv.sql} ${insert}
               SELECT ${newId("d")}, 'reminder_survey', t.id, t.beta_id, MIN(b.id), 'reminder_survey:' || b.survey_id || ':' || t.id, ${PRIORITY.reminder_survey}, 'pending', 0, ?, ?
               FROM downloads dl JOIN builds b ON b.id = dl.build_id JOIN testers t ON t.id = dl.tester_id JOIN cfg ON cfg.beta_id = t.beta_id LEFT JOIN betas bt ON bt.id = t.beta_id
               WHERE dl.result = 'started' AND b.survey_id IS NOT NULL AND dl.at <= ? - cfg.days * ${DAY} AND dl.at > ? - (cfg.days + 14) * ${DAY}
                 AND t.status = 'active' AND t.reminders_off = 0 AND bt.closed_at IS NULL
                 AND NOT EXISTS (SELECT 1 FROM responses r WHERE r.survey_id = b.survey_id AND r.tester_id = t.id)
               GROUP BY b.survey_id, t.id
               ON CONFLICT (dedupe) DO NOTHING`,
            )
            .bind(...sv.params, now, now, now, now),
        );
      }
      const ending = betas.filter((b) => b.reminders.endingSoon > 0 && b.endsAt && b.endsAt > now && b.endsAt - b.reminders.endingSoon * DAY <= now).map((b) => b.id);
      if (ending.length) {
        stmts.push(
          app.db
            .prepare(
              `${insert}
               SELECT ${newId("d")}, 'reminder_ending', t.id, t.beta_id, t.beta_id, 'reminder_ending:' || t.beta_id || ':' || t.id, ${PRIORITY.reminder_ending}, 'pending', 0, ?, ?
               FROM testers t LEFT JOIN betas bt ON bt.id = t.beta_id WHERE t.beta_id IN (${ending.map(() => "?").join(",")}) AND t.status = 'active' AND t.reminders_off = 0 AND bt.closed_at IS NULL
               ON CONFLICT (dedupe) DO NOTHING`,
            )
            .bind(now, now, ...ending),
        );
      }
      const res = await app.db.batch(stmts);
      out.reminders = res.filter((_, i) => i !== announceAt).reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
    }

    // ---- 5. expiry, retention, owner notices ----

    async housekeeping(app, h, out, budget) {
      const now = app.now;
      const r = await app.db.prepare("UPDATE invites SET status = 'expired' WHERE status = 'sent' AND expires_at <= ?").bind(now).run();
      out.expired = r.meta.changes;
      if (now - (h.housekeepingAt ?? 0) < HOUSEKEEPING_MS) return;
      h.housekeepingAt = now;
      const lim = (table, where) => `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${DELETE_LIMIT})`;
      const betas = app.cfg.betas.filter((b) => !b.error);
      const declined = cfgValues(betas.map((b) => [b.id, b.retention.declinedDays]));
      const stmts = [
        app.db.prepare(lim("signins", "created_at < ?")).bind(now - DAY),
        app.db.prepare(lim("events", "at < ?")).bind(now - 180 * DAY),
        app.db.prepare(lim("downloads", "at < ?")).bind(now - 180 * DAY),
        app.db.prepare(lim("deliveries", "status IN ('sent','failed') AND created_at < ?")).bind(now - 180 * DAY),
        app.db.prepare(lim("rate", "expires_at < ?")).bind(now),
        app.db.prepare(lim("acceptances", "delete_after IS NOT NULL AND delete_after <= ?")).bind(now),
      ];
      if (declined) {
        // Blocked applicants keep only their email_hmac (so a re-application stays blocked).
        stmts.push(
          app.db
            .prepare(
              `${declined.sql} UPDATE testers SET email = '', name = NULL, answers = NULL, src = NULL WHERE status = 'blocked' AND email != ''
               AND decided_at <= ? - (SELECT days FROM cfg WHERE cfg.beta_id = testers.beta_id) * ${DAY}`,
            )
            .bind(...declined.params, now),
          app.db
            .prepare(`${declined.sql} SELECT t.id, t.beta_id FROM testers t JOIN cfg ON cfg.beta_id = t.beta_id WHERE t.status = 'declined' AND t.decided_at <= ? - cfg.days * ${DAY} LIMIT 20`)
            .bind(...declined.params, now),
        );
      }
      const after = cfgValues(betas.map((b) => [b.id, b.retention.afterCloseDays]));
      if (after) {
        stmts.push(
          app.db
            .prepare(`${after.sql} SELECT t.id, t.beta_id FROM testers t JOIN cfg ON cfg.beta_id = t.beta_id JOIN betas b ON b.id = t.beta_id WHERE b.closed_at IS NOT NULL AND b.closed_at <= ? - cfg.days * ${DAY} LIMIT 20`)
            .bind(...after.params, now),
        );
      }
      const res = await app.db.batch(stmts);
      out.deleted += res.slice(0, 6).reduce((n, x) => n + (x.meta?.changes ?? 0), 0);
      const toDelete = [...(declined ? res[7].results : []), ...(after ? res[res.length - 1].results : [])];
      const byBeta = new Map();
      for (const t of toDelete) byBeta.set(t.beta_id, [...new Set([...(byBeta.get(t.beta_id) ?? []), t.id])]);
      for (const [betaId, ids] of byBeta) {
        if (budget.left < 4) break;
        const beta = app.cfg.byId.get(betaId);
        const d = await deleteTesters(app, ids, { keepBugs: beta.keepBugs, acceptanceDays: beta.retention.acceptanceDays });
        out.deleted += d.deleted;
        if (d.r2Keys.length && app.env.FILES && spend(budget, 1)) await app.env.FILES.delete(d.r2Keys).catch(() => {});
      }
    }

    async ownerNotice(app, h, out, budget) {
      const now = app.now;
      if (now - (h.noticeAt ?? 0) < NOTICE_MS) return;
      const rows = (
        await app.db
          .prepare("SELECT kind, beta_id, COUNT(*) AS n, MAX(at) AS last FROM events WHERE at > ? AND at <= ? AND kind IN ('applied','bug','upstream_error') GROUP BY kind, beta_id")
          .bind(h.noticeCursor ?? 0, now)
          .all()
      ).results;
      h.noticeAt = now;
      h.noticeCursor = now;
      if (!rows.length) return;
      const env = app.env;
      const to = String(env.OWNER_EMAIL ?? "").trim();
      const from = String(env.MAIL_FROM ?? "").trim();
      if (!to || !from || !env.EMAIL || typeof env.EMAIL.send !== "function") return;
      if (!spend(budget, 1)) return;
      const label = { applied: "new applications", bug: "new bug reports", upstream_error: "builds temporarily unavailable" };
      const lines = rows.map((r) => `${app.cfg.byId.get(r.beta_id)?.name ?? r.beta_id}: ${r.n} ${label[r.kind]}`);
      const text = `${lines.join("\n")}\n\nOpen the Perchlight app or GET ${app.base}/api/dashboard for details.`;
      try {
        const raw = mime({ from, to, subject: `perchlight-beta: ${lines.length === 1 ? lines[0] : `${rows.reduce((n, r) => n + r.n, 0)} updates`}`, text, html: `<pre>${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])}</pre>`, now });
        await env.EMAIL.send(new EmailMessage(addressOnly(from), addressOnly(to), raw));
        out.notice = true;
        h.fp.notices++;
      } catch (err) {
        console.error(`owner notice: ${redactAddresses(errText(err))}`);
      }
    }
  };
}

function h_emails(clock, n) {
  if (clock.hot) clock.hot.fp.emails += n;
}
