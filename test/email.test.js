import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { resetAll, synced, rows, api, emails, runClock, inClock, fakeNet, NOW, MIN, HOUR, DAY, fakeKeys, setNow } from "./helpers.js";
import { capLeft, addCount, daysToSend, nextRetryAt } from "../src/lib/queue.js";
import { queueSignin } from "../src/routes/signin.js";
import { makeApp } from "../src/lib/appctx.js";
import { TEST_CONFIG } from "./config.js";
import { emailHmac } from "../src/lib/testers.js";

const caps = { dailyCap: 90, monthlyCap: 2800 };

/** n applicants to alpha, inserted directly (the apply route is tested elsewhere). */
let seq = 0;
async function applicants(n, beta = "alpha") {
  const app = { env };
  const ids = [];
  const stmts = [];
  for (let k = 0; k < n; k++) {
    const i = seq++;
    const tid = `t_${(i + 1000000).toString(36).padStart(16, "a")}`;
    ids.push(tid);
    stmts.push(
      env.DB.prepare("INSERT INTO testers (id, beta_id, email, email_hmac, name, status, reader_code, applied_at) VALUES (?, ?, ?, ?, ?, 'applied', ?, ?)").bind(
        tid,
        beta,
        `p${i}@example.com`,
        await emailHmac(app, `p${i}@example.com`),
        `P${i}`,
        `RC${String(i).padStart(6, "0")}`,
        NOW,
      ),
    );
  }
  await env.DB.batch(stmts);
  return ids;
}

describe("email cap arithmetic", () => {
  it("counts per UTC day and month, across both boundaries", () => {
    const t = Date.UTC(2026, 10, 30, 23, 59);
    let c = addCount({ day: "", dayCount: 0, month: "", monthCount: 0 }, 89, t);
    expect(capLeft(c, caps, t)).toBe(1);
    c = addCount(c, 1, t);
    expect(capLeft(c, caps, t)).toBe(0);
    const next = Date.UTC(2026, 11, 1, 0, 1); // a new day and a new month
    expect(capLeft(c, caps, next)).toBe(90);
    const sameMonth = { day: "2026-11-30", dayCount: 10, month: "2026-11", monthCount: 2795 };
    expect(capLeft(sameMonth, caps, t)).toBe(5);
    expect(capLeft(sameMonth, caps, Date.UTC(2026, 11, 1))).toBe(90);
  });

  it("reports how many days a queue takes", () => {
    expect(daysToSend(150, 0, 0, 90)).toBe(2);
    expect(daysToSend(90, 0, 0, 90)).toBe(1);
    expect(daysToSend(1, 0, 90, 90)).toBe(2);
    expect(daysToSend(10, 175, 0, 90)).toBe(3);
  });

  it("retries at 1, 5, 30 minutes, 2 hours, 12 hours, then stops", () => {
    expect([1, 2, 3, 4, 5].map((a) => (nextRetryAt(a, 0) ?? 0) / MIN)).toEqual([1, 5, 30, 120, 720]);
    expect(nextRetryAt(6, 0)).toBe(null);
  });
});

describe("the email queue", () => {
  let calls;
  beforeEach(async () => {
    await resetAll({ KEYS: fakeKeys().binding });
    calls = await synced();
  });

  it("150 approvals with dailyCap 90: 90 on day one, 60 on day two; never a duplicate; at most 30 a run within the budget", async () => {
    const ids = await applicants(150);
    const r = await api("POST", "applications/decide", { ids, action: "approve" });
    expect(r.data.invites).toBe(150);
    expect(r.data.email.summary).toBe("150 invites: sent over 2 days");
    let t = NOW + MIN;
    for (let i = 0; i < 6; i++) {
      const out = await runClock(t);
      expect(out.sent).toBeLessThanOrEqual(30);
      t += 3000;
    }
    // The alarm runs twice more at the same moment: nothing more today.
    await runClock(t);
    await runClock(t);
    const day1 = emails(calls);
    expect(day1).toHaveLength(90);
    expect(new Set(day1.map((m) => m.to)).size).toBe(90);
    const waiting = await rows("SELECT COUNT(*) AS n, MIN(not_before_day) AS d FROM deliveries WHERE kind = 'invite' AND status = 'pending'");
    expect(waiting[0]).toEqual({ n: 60, d: "2026-11-03" });
    const st = await inClock((c) => c.hot.fp);
    expect(st.subrequests / st.runs).toBeLessThan(45);
    // Day two.
    t = Date.UTC(2026, 10, 3, 0, 1);
    for (let i = 0; i < 4; i++) {
      await runClock(t);
      t += 3000;
    }
    const all = emails(calls);
    expect(all).toHaveLength(150);
    expect(new Set(all.map((m) => m.to)).size).toBe(150);
    expect(new Set(all.map((m) => m.key)).size).toBe(150);
  });

  it("sign-in links go before queued invites", async () => {
    // A tester who can sign in.
    const [active] = await applicants(1);
    await env.DB.prepare("UPDATE testers SET status = 'active' WHERE id = ?").bind(active).run();
    const ids = (await applicants(40, "book")).slice(0);
    await api("POST", "applications/decide", { ids, action: "approve" });
    const app = makeApp(TEST_CONFIG, {}, env, { now: () => NOW });
    const email = (await rows("SELECT email FROM testers WHERE id = ?", active))[0].email;
    expect((await queueSignin(app, email, "alpha", "iphash")).queued).toBe(true);
    await runClock(NOW + MIN);
    const sent = emails(calls);
    expect(sent).toHaveLength(30);
    expect(sent[0].subject).toContain("Sign in");
    expect(sent.slice(1).every((m) => /invited/.test(m.subject))).toBe(true);
  });

  it("a throttled answer moves the rest to the next day; sign-ins are tried first then", async () => {
    const ids = await applicants(5, "book");
    await api("POST", "applications/decide", { ids, action: "approve" });
    calls = fakeNet({ "https://api.resend.com/": { status: 429, body: JSON.stringify({ name: "daily_quota_exceeded", message: "quota" }) } });
    await runClock(NOW + MIN);
    const d = await rows("SELECT status, not_before_day, attempts FROM deliveries WHERE kind = 'invite'");
    expect(d.every((x) => x.status === "pending" && x.not_before_day === "2026-11-03" && x.attempts === 0)).toBe(true);
    calls = fakeNet();
    await runClock(NOW + 2 * HOUR);
    expect(emails(calls)).toHaveLength(0);
    await runClock(Date.UTC(2026, 10, 3, 0, 5));
    expect(emails(calls)).toHaveLength(5);
  });

  it("an unknown result is retried with the same idempotency key", async () => {
    const ids = await applicants(1, "book");
    await api("POST", "applications/decide", { ids, action: "approve" });
    calls = fakeNet({ "https://api.resend.com/": [{ status: 500, body: "{}" }][0] });
    await runClock(NOW + MIN);
    const first = emails(calls)[0];
    expect((await rows("SELECT status FROM deliveries WHERE kind = 'invite'"))[0].status).toBe("retry");
    // The link already works (the email may have arrived).
    expect((await rows("SELECT status FROM invites"))[0].status).toBe("sent");
    calls = fakeNet();
    await runClock(NOW + 3 * MIN);
    const second = emails(calls)[0];
    expect(second.key).toBe(first.key);
    expect(second.text).toBe(first.text);
    expect((await rows("SELECT status FROM deliveries WHERE kind = 'invite'"))[0].status).toBe("sent");
  });

  it("an interrupted claim is retried with the same key, never a second delivery row", async () => {
    const ids = await applicants(1, "book");
    await api("POST", "applications/decide", { ids, action: "approve" });
    await env.DB.prepare("UPDATE deliveries SET status = 'sending', claimed_at = ?, attempts = 1").bind(NOW).run();
    await runClock(NOW + MIN);
    expect(emails(calls)).toHaveLength(0);
    await runClock(NOW + 12 * MIN);
    expect(emails(calls)).toHaveLength(1);
    expect(await rows("SELECT id FROM deliveries")).toHaveLength(1);
  });

  it("a revoked invite's queued email is dropped", async () => {
    const ids = await applicants(1, "book");
    await api("POST", "applications/decide", { ids, action: "approve" });
    await api("POST", `testers/${ids[0]}/revoke`);
    await api("POST", "applications/decide", { ids, action: "decline" });
    await runClock(NOW + MIN);
    expect(emails(calls)).toHaveLength(0);
  });

  it("the app shows when queued email will go", async () => {
    const ids = await applicants(100, "book");
    await api("POST", "applications/decide", { ids, action: "approve" });
    for (let i = 0; i < 4; i++) await runClock(NOW + MIN + i * 3000);
    const q = await api("GET", "deliveries?status=pending");
    expect(q.data.queue.summary).toBe("Queued: 10, sending from 00:00 UTC");
    setNow(NOW);
  });

  it("POST /api/test-email sends one email under the cap", async () => {
    const r = await api("POST", "test-email", {});
    expect(r.data.status).toBe("sent");
    expect(emails(calls)[0].to).toBe("owner@example.com");
    void DAY;
  });
});
