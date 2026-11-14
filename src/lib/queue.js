// The tester email queue (docs/SDD.md, "Email"). Deliveries are created by
// the Worker or Clock, and sent ONLY by Clock, so the daily and monthly caps
// are enforced in one place. Each delivery has a unique dedupe key (one per
// email or reminder occurrence) and is claimed (status 'sending') before it
// is sent. Retries follow perchlight-forms' ladder; a `throttled` result or a
// full cap moves the delivery to the next UTC day instead.
import { randomId } from "./crypto.js";
import { nextDay, utcDay, utcMonth } from "./http.js";

export const PRIORITY = { signin: 0, invite: 1, new_build: 2, reminder_invite: 3, reminder_survey: 3, reminder_ending: 3, key_issue: 9, key_revoke: 9 };
export const EMAIL_KINDS = new Set(["signin", "invite", "new_build", "reminder_invite", "reminder_survey", "reminder_ending"]);
/** perchlight-forms src/lib/deliveries.js: 1 / 5 / 30 min, 2 h, 12 h. */
export const BACKOFF_MINUTES = [1, 5, 30, 120, 720];
/** A claim older than this was interrupted; it's retried with the same idempotency key. */
export const STALE_CLAIM_MS = 10 * 60_000;

/** When the next attempt is due after `attempts` failures, or null when the ladder is used up. */
export function nextRetryAt(attempts, now) {
  if (attempts < 1 || attempts > BACKOFF_MINUTES.length) return null;
  return now + BACKOFF_MINUTES[attempts - 1] * 60_000;
}

/**
 * How many emails may still go out now.
 * @param {{ day: string, dayCount: number, month: string, monthCount: number }} counts
 */
export function capLeft(counts, caps, now) {
  const day = utcDay(now);
  const month = utcMonth(now);
  const d = counts.day === day ? counts.dayCount : 0;
  const m = counts.month === month ? counts.monthCount : 0;
  return Math.max(0, Math.min(caps.dailyCap - d, caps.monthlyCap - m));
}

/** Counts after `n` more emails (claimed before sending, so a crash never exceeds the cap). */
export function addCount(counts, n, now) {
  const day = utcDay(now);
  const month = utcMonth(now);
  return {
    day,
    dayCount: (counts.day === day ? counts.dayCount : 0) + n,
    month,
    monthCount: (counts.month === month ? counts.monthCount : 0) + n,
  };
}

/**
 * How many UTC days it takes to send `n` more emails behind `ahead` already queued
 * (1 = all today), with `sentToday` already sent and `dailyCap` a day.
 */
export function daysToSend(n, ahead, sentToday, dailyCap) {
  const total = ahead + n;
  const today = Math.max(0, dailyCap - sentToday);
  if (total <= today) return 1;
  return 1 + Math.ceil((total - today) / dailyCap);
}

export function tomorrow(now) {
  return nextDay(utcDay(now));
}

/** INSERT for one delivery; a repeat of the same dedupe key does nothing. */
export function deliveryStmt(db, { kind, testerId, betaId, ref, dedupe, now, nextAt }) {
  return db
    .prepare(
      "INSERT INTO deliveries (id, kind, tester_id, beta_id, ref, dedupe, priority, status, attempts, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?) ON CONFLICT (dedupe) DO NOTHING",
    )
    .bind(randomId("d"), kind, testerId ?? null, betaId ?? null, ref ?? null, dedupe, PRIORITY[kind], nextAt ?? now, now);
}
