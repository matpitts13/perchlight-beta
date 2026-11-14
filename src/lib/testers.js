// Decisions on testers (approve, decline, waitlist, block, revoke, re-send),
// shared by the admin API (at once, in bulk) and Clock (the desktop app's
// action_requested, within 5 minutes). Plus export and delete.
//
// Approve creates the invite (status 'queued', a placeholder hash) and its
// delivery in the same D1 batch; Clock makes the token when it sends,
// stores its SHA-256 and marks the invite 'sent' (docs/SDD.md, "Invites").
// Every statement is set-based and parameterised, at most 90 ids at a time
// (D1 allows 100 bound parameters per query).
import { hmacHex } from "./crypto.js";
import { PRIORITY } from "./queue.js";

export const CHUNK = 90;
const LIVE = "('approved','invited','active')";
const UNDECIDED = ["applied", "waitlisted", "declined"];
const BEFORE_ACTIVE = ["applied", "waitlisted", "declined", "approved", "invited"];
const marks = (n) => Array(n).fill("?").join(",");
const newId = (p) => `'${p}_' || lower(hex(randomblob(10)))`;

export function normEmail(v) {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s.length < 3 || s.length > 254 || !/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(s)) return null;
  return s;
}

export async function emailHmac(app, email) {
  return hmacHex(app.env.LINK_SECRET || "", `email/${email}`);
}

function chunks(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(ids.slice(i, i + CHUNK));
  return out;
}

/** Statements: revoke a tester's open invites and drop their unsent invite emails. */
function closeInvitesStmts(db, ids) {
  return [
    db.prepare(`UPDATE invites SET status = 'revoked' WHERE tester_id IN (${marks(ids.length)}) AND status IN ('queued','sent')`).bind(...ids),
    db.prepare(`DELETE FROM deliveries WHERE tester_id IN (${marks(ids.length)}) AND kind IN ('invite','reminder_invite') AND status IN ('pending','retry')`).bind(...ids),
  ];
}

/** Statements that queue one invite (and its email) for each id currently 'approved' with no open invite. */
function inviteStmts(db, ids, now) {
  const m = marks(ids.length);
  return [
    db
      .prepare(
        `INSERT INTO invites (id, tester_id, token_hash, status, created_at)
         SELECT inv, tid, 'queued:' || inv, 'queued', ? FROM (SELECT ${newId("i")} AS inv, t.id AS tid FROM testers t WHERE t.id IN (${m}) AND t.status = 'approved'
           AND NOT EXISTS (SELECT 1 FROM invites i WHERE i.tester_id = t.id AND i.status IN ('queued','sent')))`,
      )
      .bind(now, ...ids),
    db
      .prepare(
        `INSERT INTO deliveries (id, kind, tester_id, beta_id, ref, dedupe, priority, status, attempts, next_at, created_at)
         SELECT ${newId("d")}, 'invite', t.id, t.beta_id, i.id, 'invite:' || i.id, ${PRIORITY.invite}, 'pending', 0, ?, ?
         FROM invites i JOIN testers t ON t.id = i.tester_id WHERE i.tester_id IN (${m}) AND i.status = 'queued'
         ON CONFLICT (dedupe) DO NOTHING`,
      )
      .bind(now, now, ...ids),
  ];
}

function eventStmt(db, ids, kind, now, detail = null) {
  return db
    .prepare(`INSERT INTO events (id, tester_id, beta_id, kind, at, detail) SELECT ${newId("e")}, id, beta_id, ?, ?, ? FROM testers WHERE id IN (${marks(ids.length)})`)
    .bind(kind, now, detail, ...ids);
}

/** Statements that revoke testers' access (status, session, invites, sign-ins, unsent mail, key). */
export function endAccessStmts(db, ids, status, now) {
  const m = marks(ids.length);
  return [
    db
      .prepare(
        `INSERT INTO deliveries (id, kind, tester_id, beta_id, ref, dedupe, priority, status, attempts, next_at, created_at)
         SELECT ${newId("d")}, 'key_revoke', NULL, beta_id, license_id, 'key_revoke:' || license_id, ${PRIORITY.key_revoke}, 'pending', 0, ?, ?
         FROM testers WHERE id IN (${m}) AND license_id IS NOT NULL AND status IN ${LIVE} ON CONFLICT (dedupe) DO NOTHING`,
      )
      .bind(now, now, ...ids),
    db
      .prepare(
        `UPDATE testers SET status = ?, session_ver = session_ver + 1, decided_at = ?, action_requested = NULL,
         key_status = CASE WHEN license_id IS NOT NULL THEN 'revoking' ELSE key_status END
         WHERE id IN (${m}) AND status IN ${LIVE}`,
      )
      .bind(status, now, ...ids),
    ...closeInvitesStmts(db, ids),
    db.prepare(`DELETE FROM signins WHERE tester_id IN (${m})`).bind(...ids),
    db.prepare(`DELETE FROM deliveries WHERE tester_id IN (${m}) AND kind NOT IN ('key_issue','key_revoke') AND status IN ('pending','retry')`).bind(...ids),
    db.prepare(`DELETE FROM deliveries WHERE tester_id IN (${m}) AND kind = 'key_issue' AND status IN ('pending','retry')`).bind(...ids),
  ];
}

/**
 * Applies one action to testers.
 * @param {"approve"|"decline"|"waitlist"|"block"|"revoke"|"resend_invite"} action
 * @returns {Promise<{ changed: number, waitlisted: number, invites: number }>}
 */
export async function decide(app, ids, action) {
  const db = app.db;
  const now = app.now;
  const out = { changed: 0, waitlisted: 0, invites: 0 };
  ids = [...new Set(ids.filter((x) => typeof x === "string" && /^t_[a-z0-9]{16}$/.test(x)))];
  for (const part of chunks(ids)) {
    const m = marks(part.length);
    if (action === "approve") {
      const rows = (await db.prepare(`SELECT id, beta_id, status FROM testers WHERE id IN (${m})`).bind(...part).all()).results;
      // In the order asked for: when maxTesters is near, the first ids get the places.
      rows.sort((a, b) => part.indexOf(a.id) - part.indexOf(b.id));
      const byBeta = new Map();
      for (const r of rows) if (UNDECIDED.includes(r.status) && app.cfg.byId.has(r.beta_id)) byBeta.set(r.beta_id, [...(byBeta.get(r.beta_id) ?? []), r.id]);
      for (const [betaId, list] of byBeta) {
        const beta = app.cfg.byId.get(betaId);
        const live = (await db.prepare(`SELECT COUNT(*) AS n FROM testers WHERE beta_id = ? AND status IN ${LIVE}`).bind(betaId).first())?.n ?? 0;
        const room = Math.max(0, beta.maxTesters - live);
        const ok = list.slice(0, room);
        const over = list.slice(room);
        const stmts = [];
        if (ok.length) {
          stmts.push(
            db.prepare(`UPDATE testers SET status = 'approved', decided_at = ?, action_requested = NULL, note = NULL WHERE id IN (${marks(ok.length)}) AND status IN ('applied','waitlisted','declined')`).bind(now, ...ok),
            ...inviteStmts(db, ok, now),
            eventStmt(db, ok, "approved", now),
          );
        }
        if (over.length) {
          stmts.push(
            db
              .prepare(`UPDATE testers SET status = 'waitlisted', action_requested = NULL, note = ? WHERE id IN (${marks(over.length)}) AND status IN ('applied','waitlisted','declined')`)
              .bind(`maxTesters (${beta.maxTesters}) reached; waitlisted`, ...over),
          );
        }
        if (!stmts.length) continue;
        const res = await db.batch(stmts);
        if (ok.length) {
          out.changed += res[0].meta.changes;
          out.invites += res[1].meta.changes;
        }
        if (over.length) out.waitlisted += res[res.length - 1].meta.changes;
      }
      // Anything else asked for (already decided, unknown beta): clear the request.
      await db.prepare(`UPDATE testers SET action_requested = NULL WHERE id IN (${m}) AND action_requested IS NOT NULL`).bind(...part).run();
      continue;
    }
    let stmts;
    if (action === "decline" || action === "waitlist" || action === "block") {
      const status = { decline: "declined", waitlist: "waitlisted", block: "blocked" }[action];
      const from = action === "block" ? BEFORE_ACTIVE : BEFORE_ACTIVE.filter((s) => s !== "declined" || action === "waitlist");
      stmts = [
        ...closeInvitesStmts(db, part),
        db
          .prepare(`UPDATE testers SET status = ?, decided_at = ?, action_requested = NULL WHERE id IN (${m}) AND status IN (${marks(from.length)})`)
          .bind(status, now, ...part, ...from),
      ];
      // closeInvites only for those that changed: the invites of a tester whose status
      // didn't match are already closed (they can't be approved/invited).
      stmts.push(eventStmt(db, part, status, now));
      const res = await db.batch(stmts);
      out.changed += res[2].meta.changes;
    } else if (action === "revoke") {
      const res = await db.batch([...endAccessStmts(db, part, "revoked", now), eventStmt(db, part, "revoked", now)]);
      out.changed += res[1].meta.changes;
    } else if (action === "resend_invite") {
      // A new token replaces the old one: the old invite is revoked, a new one queued.
      const res = await db.batch([
        db.prepare(`UPDATE invites SET status = 'revoked' WHERE tester_id IN (${m}) AND status IN ('queued','sent')`).bind(...part),
        db.prepare(`DELETE FROM deliveries WHERE tester_id IN (${m}) AND kind = 'invite' AND status IN ('pending','retry')`).bind(...part),
        db.prepare(`UPDATE testers SET status = 'approved', action_requested = NULL WHERE id IN (${m}) AND status IN ('approved','invited')`).bind(...part),
        ...inviteStmts(db, part, now),
      ]);
      out.changed += res[2].meta.changes;
      out.invites += res[3].meta.changes;
    } else {
      continue;
    }
    await db.prepare(`UPDATE testers SET action_requested = NULL WHERE id IN (${m}) AND action_requested IS NOT NULL`).bind(...part).run();
  }
  return out;
}

/** Every row tied to these testers (one person: same email_hmac across betas). */
export async function exportData(app, emailHmacValue) {
  const db = app.db;
  const testers = (
    await db
      .prepare(
        "SELECT id, beta_id, email, name, answers, src, status, reader_code, groups, terms_accepted_version, license_id, key_status, reminders_off, applied_at, decided_at, activated_at, last_seen_day FROM testers WHERE email_hmac = ?",
      )
      .bind(emailHmacValue)
      .all()
  ).results;
  const ids = testers.map((t) => t.id);
  const data = { exported_at: new Date(app.now).toISOString(), testers, invites: [], acceptances: [], downloads: [], responses: [], bugs: [], bug_images: [], events: [], deliveries: [], signins: [] };
  if (!ids.length) return data;
  const m = marks(ids.length);
  const q = (sql) => db.prepare(sql).bind(...ids);
  const res = await db.batch([
    q(`SELECT id, tester_id, status, created_at, sent_at, expires_at, claimed_at FROM invites WHERE tester_id IN (${m})`),
    q(`SELECT id, tester_id, beta_id, version, text_sha256, full_name, how, accepted_at FROM acceptances WHERE tester_id IN (${m})`),
    q(`SELECT id, tester_id, build_id, at, source, result, colo FROM downloads WHERE tester_id IN (${m})`),
    q(`SELECT survey_id, tester_id, build_id, beta_id, answers, submitted_at, updated_at FROM responses WHERE tester_id IN (${m})`),
    q(`SELECT id, tester_id, beta_id, build_id, title, body, severity, platform, status, images, images_note, created_at FROM bugs WHERE tester_id IN (${m})`),
    q(`SELECT bug_id, n, mime, size FROM bug_images WHERE bug_id IN (SELECT id FROM bugs WHERE tester_id IN (${m}))`),
    q(`SELECT id, tester_id, beta_id, kind, at, detail FROM events WHERE tester_id IN (${m})`),
    q(`SELECT id, kind, tester_id, status, attempts, created_at, sent_at FROM deliveries WHERE tester_id IN (${m})`),
    q(`SELECT id, tester_id, created_at, expires_at, used_at FROM signins WHERE tester_id IN (${m})`),
  ]);
  [data.invites, data.acceptances, data.downloads, data.responses, data.bugs, data.bug_images, data.events, data.deliveries, data.signins] = res.map((r) => r.results);
  for (const t of data.testers) t.answers = t.answers ? JSON.parse(t.answers) : null;
  for (const r of data.responses) r.answers = JSON.parse(r.answers);
  return data;
}

/**
 * Deletes testers now (on request, or by retention), leaving only the
 * pseudonymised acceptance (email_hmac, version, text hash, time), kept
 * acceptanceDays (0 = deleted too). Also revokes their perchlight-keys key.
 * R2 screenshot keys to delete are returned (the caller deletes them).
 */
export async function deleteTesters(app, ids, { keepBugs = false, acceptanceDays = 730 } = {}) {
  const db = app.db;
  const now = app.now;
  const r2Keys = [];
  let deleted = 0;
  for (const part of chunks(ids)) {
    const m = marks(part.length);
    if (app.env.FILES) {
      const keys = (await db.prepare(`SELECT r2_key FROM bug_images WHERE r2_key IS NOT NULL AND bug_id IN (SELECT id FROM bugs WHERE tester_id IN (${m}))`).bind(...part).all()).results;
      if (!keepBugs) r2Keys.push(...keys.map((k) => k.r2_key));
    }
    const res = await db.batch([
      db
        .prepare(
          `INSERT INTO deliveries (id, kind, tester_id, beta_id, ref, dedupe, priority, status, attempts, next_at, created_at)
           SELECT ${newId("d")}, 'key_revoke', NULL, beta_id, license_id, 'key_revoke:' || license_id, ${PRIORITY.key_revoke}, 'pending', 0, ?, ?
           FROM testers WHERE id IN (${m}) AND license_id IS NOT NULL ON CONFLICT (dedupe) DO NOTHING`,
        )
        .bind(now, now, ...part),
      acceptanceDays > 0
        ? db.prepare(`UPDATE acceptances SET tester_id = NULL, full_name = NULL, delete_after = ? WHERE tester_id IN (${m})`).bind(now + acceptanceDays * 86_400_000, ...part)
        : db.prepare(`DELETE FROM acceptances WHERE tester_id IN (${m})`).bind(...part),
      keepBugs
        ? db.prepare(`UPDATE bugs SET tester_id = NULL WHERE tester_id IN (${m})`).bind(...part)
        : db.prepare(`DELETE FROM bug_images WHERE bug_id IN (SELECT id FROM bugs WHERE tester_id IN (${m}))`).bind(...part),
      db.prepare(`DELETE FROM bugs WHERE tester_id IN (${m})`).bind(...part),
      db.prepare(`DELETE FROM invites WHERE tester_id IN (${m})`).bind(...part),
      db.prepare(`DELETE FROM signins WHERE tester_id IN (${m})`).bind(...part),
      db.prepare(`DELETE FROM downloads WHERE tester_id IN (${m})`).bind(...part),
      db.prepare(`DELETE FROM responses WHERE tester_id IN (${m})`).bind(...part),
      db.prepare(`DELETE FROM events WHERE tester_id IN (${m})`).bind(...part),
      db.prepare(`DELETE FROM deliveries WHERE tester_id IN (${m})`).bind(...part),
      db.prepare(`DELETE FROM testers WHERE id IN (${m})`).bind(...part),
    ]);
    deleted += res[res.length - 1].meta.changes;
  }
  return { deleted, r2Keys };
}
