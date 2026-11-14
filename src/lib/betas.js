// A beta's effective state: beta.json's status, overridden to "closed" once
// POST /api/betas/:id/close has set closed_at in D1.

/** { beta, status, closedAt } — status null when the beta doesn't exist or is switched off. */
export async function betaState(app, id) {
  const beta = typeof id === "string" ? app.cfg.byId.get(id) : undefined;
  if (!beta) return { beta: null, status: null, closedAt: null };
  const row = await app.db.prepare("SELECT closed_at FROM betas WHERE id = ?").bind(id).first();
  const closedAt = row?.closed_at ?? null;
  return { beta, status: closedAt ? "closed" : beta.status, closedAt };
}

/** Downloads stop closeGraceDays after a beta is closed. */
export function downloadsStopped(beta, closedAt, now) {
  return closedAt !== null && closedAt !== undefined && now > closedAt + beta.closeGraceDays * 86_400_000;
}
