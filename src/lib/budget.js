// A per-invocation budget of subrequests. From perchlight-hooks
// src/lib/budget.js. Workers Free allows 50 subrequests per invocation;
// whether D1, Durable Object and send_email binding calls count isn't
// confirmed, so this assumes they all do and keeps one Clock run under 45.

export const SUBREQUEST_BUDGET = 45;

/** Worst cases, counted by hand from src/clock.js. */
export const COST = {
  // config sync, actions read + write, due read, claim, results, reminders,
  // expiry + retention, owner notice read, a spare
  d1Reserve: 10,
  // one perchlight-keys call per run
  keys: 1,
  // one owner notice (send_email) per run
  notice: 1,
  // one Resend request per email
  email: 1,
};

/** At most this many emails in one run (45 - 10 - 1 - 1 = 33, held to 30 as the SDD says). */
export const MAX_EMAILS_PER_RUN = 30;

export function newBudget(total = SUBREQUEST_BUDGET) {
  return { left: total, used: 0 };
}

export function spend(budget, n) {
  if (budget.left < n) return false;
  budget.left -= n;
  budget.used += n;
  return true;
}

export function refund(budget, n) {
  if (n <= 0) return;
  budget.left += n;
  budget.used -= n;
}
