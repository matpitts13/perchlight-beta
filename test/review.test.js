// Regression tests for the v0.1 review findings (H1-H3, M1-M4).
import { describe, it, expect, beforeEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { resetAll, synced, rows, api, emails, runClock, inClock, clockStub, invited, activeTester, get, post, call, csrfOf, fakeKeys, setEnv, ORIGIN, NOW, MIN } from "./helpers.js";
import { checkConfig, MAX_BUILDS } from "../src/lib/config.js";
import { queueSignin } from "../src/routes/signin.js";
import { makeApp } from "../src/lib/appctx.js";
import { emailHmac } from "../src/lib/testers.js";
import { TEST_CONFIG } from "./config.js";

let seq = 0;
async function applicants(n, beta = "book") {
  const ids = [];
  const stmts = [];
  for (let k = 0; k < n; k++) {
    const i = seq++;
    const id = `t_${(i + 2000000).toString(36).padStart(16, "b")}`;
    ids.push(id);
    stmts.push(
      env.DB.prepare("INSERT INTO testers (id, beta_id, email, email_hmac, name, status, reader_code, applied_at) VALUES (?, ?, ?, ?, 'R', 'applied', ?, ?)").bind(
        id,
        beta,
        `r${i}@example.com`,
        await emailHmac({ env }, `r${i}@example.com`),
        `RV${String(i).padStart(6, "0")}`,
        NOW,
      ),
    );
  }
  await env.DB.batch(stmts);
  return ids;
}

describe("review regressions", () => {
  let calls;
  beforeEach(async () => {
    await resetAll({ KEYS: fakeKeys().binding });
    calls = await synced();
  });

  it("H1: pages use Referrer-Policy same-origin; a POST with Origin: null and Sec-Fetch-Site: same-origin is accepted, without it refused", async () => {
    const { token } = await invited("alpha", "ada@example.com", calls);
    const page = await get(`/i/${token}`);
    expect(page.headers.get("Referrer-Policy")).toBe("same-origin");
    const csrf = csrfOf(await page.text());
    const fields = { csrf, version: "v1", full_name: "Ada", accept: "1" };
    expect((await post(`/i/${token}/claim`, fields, null, { Origin: "null" })).status).toBe(403);
    expect((await post(`/i/${token}/claim`, fields, null, { Origin: "null", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    const ok = await post(`/i/${token}/claim`, fields, null, { Origin: "null", "Sec-Fetch-Site": "same-origin" });
    expect(ok.status).toBe(303);
  });

  it("H2: with email not configured, a big queue doesn't make Clock run every 2 seconds", async () => {
    const ids = await applicants(40);
    await api("POST", "applications/decide", { ids, action: "approve" });
    setEnv({ RESEND_API_KEY: "" });
    const out = await runClock(NOW + MIN);
    expect(out.error).toBe(null);
    expect(out.nextAt).toBe(NOW + MIN + 5 * MIN);
    expect(emails(calls)).toHaveLength(0);
  });

  it("H3: 150 app requests of each kind fit D1's bound-parameter limit", async () => {
    const ids = await applicants(150);
    await env.DB.prepare("UPDATE testers SET action_requested = 'frobnicate'").run();
    const stmts = [];
    for (let i = 0; i < 150; i++) {
      stmts.push(
        env.DB.prepare("INSERT INTO deliveries (id, kind, tester_id, beta_id, ref, dedupe, priority, status, attempts, next_at, created_at, action_requested) VALUES (?, 'invite', NULL, 'book', NULL, ?, 1, 'failed', 5, 0, 0, 'retry')").bind(`d_x${String(i).padStart(15, "0")}`, `x${i}`),
      );
    }
    await env.DB.batch(stmts);
    const out = await runClock(NOW + MIN);
    expect(out.error).toBe(null);
    expect(await rows("SELECT id FROM testers WHERE action_requested IS NOT NULL")).toHaveLength(0);
    expect((await rows("SELECT COUNT(*) AS n FROM deliveries WHERE action_requested IS NULL AND status IN ('pending','failed')"))[0].n).toBe(150);
    void ids;
  });

  it("H3: at most 100 builds in beta.json; the rest are switched off", () => {
    const builds = Object.fromEntries(Array.from({ length: 105 }, (_, i) => [`b${i}`, { beta: "g", label: "x", url: "https://example.com/x" }]));
    const c = checkConfig({ betas: { g: { name: "G", terms: { text: "t", version: "1" } } }, builds });
    expect(MAX_BUILDS).toBe(100);
    expect(c.buildById.size).toBe(100);
    expect(c.errors.join(" ")).toContain("at most 100 builds");
  });

  it("M1: a run with 30 emails counts them against its 45-subrequest budget", async () => {
    const ids = await applicants(60);
    await api("POST", "applications/decide", { ids, action: "approve" });
    const out = await runClock(NOW + MIN);
    expect(out.sent).toBe(30);
    expect(out.subrequests).toBeGreaterThanOrEqual(30 + 3);
    expect(out.subrequests).toBeLessThanOrEqual(45);
  });

  it("M2: runs never overlap, so two at once can't exceed the cap", async () => {
    const ids = await applicants(120);
    await api("POST", "applications/decide", { ids, action: "approve" });
    const stub = clockStub();
    const [a, b] = await Promise.all([runInDurableObject(stub, (c) => c.run(NOW + MIN)), runInDurableObject(stub, (c) => c.run(NOW + MIN))]);
    expect([a.skipped, b.skipped].filter(Boolean)).toHaveLength(1);
    expect(emails(calls)).toHaveLength(30);
  });

  it("M3: with the daily cap used up, a sign-in link still goes (from the reserve); invites wait", async () => {
    const t = await activeTester("alpha", "ada@example.com", calls);
    const ids = await applicants(5);
    await api("POST", "applications/decide", { ids, action: "approve" });
    await inClock((c) => c.bump(NOW, 90 - c.counts(NOW).dayCount));
    const app = makeApp(TEST_CONFIG, {}, env, { now: () => NOW });
    expect((await queueSignin(app, "ada@example.com", "alpha", "ip")).queued).toBe(true);
    const before = emails(calls).length;
    await runClock(NOW + MIN);
    const sent = emails(calls).slice(before);
    expect(sent.map((m) => m.subject)).toEqual(["Sign in to Alpha closed beta"]);
    expect((await rows("SELECT COUNT(*) AS n FROM deliveries WHERE kind = 'invite' AND not_before_day = '2026-11-03'"))[0].n).toBe(5);
    void t;
  });

  it("M4: concurrent bug reports can't push screenshots past the total cap; each keeps all or none", async () => {
    const t = await activeTester("alpha", "ada@example.com", calls);
    const png = (n) => {
      const b = new Uint8Array(n);
      b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      return b;
    };
    const send = () => {
      const fd = new FormData();
      fd.set("csrf", t.csrf);
      fd.set("title", "Bug");
      fd.set("body", "Steps");
      fd.append("screenshot", new File([png(400 * 1024)], "a.png", { type: "image/png" }));
      fd.append("screenshot", new File([png(400 * 1024)], "b.png", { type: "image/png" }));
      return call("/t/alpha/bugs", { method: "POST", headers: { Origin: ORIGIN, Cookie: t.cookie }, body: fd });
    };
    const res = await Promise.all([send(), send(), send()]);
    expect(res.every((r) => r.status === 200)).toBe(true);
    const total = (await rows("SELECT COALESCE(SUM(size), 0) AS n FROM bug_images"))[0].n;
    expect(total).toBeLessThanOrEqual(1024 * 1024);
    const per = await rows("SELECT b.images, (SELECT COUNT(*) FROM bug_images i WHERE i.bug_id = b.id) AS n FROM bugs b");
    expect(per.every((x) => (x.n === 0 || x.n === 2) && x.images === x.n)).toBe(true);
    expect(per.filter((x) => x.n === 2)).toHaveLength(1);
  });
});
