import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { resetAll, synced, rows, api, emails, runClock, inClock, invited, activeTester, claim, post, get, fakeNet, fakeKeys, fakeEmail, setEnv, setNow, apply, NOW, MIN, HOUR, DAY } from "./helpers.js";

describe("reminders (Clock alarm, no cron)", () => {
  let calls;
  beforeEach(async () => {
    await resetAll({ KEYS: fakeKeys().binding });
    calls = await synced();
  });

  it("an unclaimed invite is reminded once after 5 days, not after a claim, not with reminders off", async () => {
    const a = await invited("alpha", "a@example.com", calls);
    const b = await invited("alpha", "b@example.com", calls);
    const c = await invited("alpha", "c@example.com", calls);
    await claim(c.token);
    await env.DB.prepare("UPDATE testers SET reminders_off = 1 WHERE id = ?").bind(b.id).run();
    await runClock(NOW + 4 * DAY);
    expect(emails(calls).filter((m) => /Reminder/.test(m.subject))).toHaveLength(0);
    await runClock(NOW + 5 * DAY + MIN);
    await runClock(NOW + 5 * DAY + 2 * MIN);
    await runClock(NOW + 6 * DAY);
    const rem = emails(calls).filter((m) => /Reminder/.test(m.subject));
    expect(rem.map((m) => m.to)).toEqual(["a@example.com"]);
    expect(rem[0].text).toContain("To stop reminders");
    void a;
  });

  it("a new build is announced once to active testers in its groups", async () => {
    const t = await activeTester("alpha", "a@example.com", calls);
    const off = await activeTester("alpha", "quiet@example.com", calls);
    await env.DB.prepare("UPDATE testers SET reminders_off = 1 WHERE id = ?").bind(off.id).run();
    // a-later becomes available 2 days in.
    await runClock(NOW + 2 * DAY + MIN);
    await runClock(NOW + 2 * DAY + 2 * MIN);
    await runClock(NOW + 2 * DAY + 3 * MIN);
    const nb = emails(calls).filter((m) => /is ready/.test(m.subject));
    expect(nb.map((m) => m.to)).toEqual(["a@example.com"]);
    expect(nb[0].subject).toBe("0.5 is ready: Alpha closed beta");
    void t;
  });

  it("a survey nudge 3 days after a download with no answer, once", async () => {
    const t = await activeTester("alpha", "a@example.com", calls);
    await env.DB.prepare("INSERT INTO downloads (id, tester_id, build_id, at, source, result) VALUES ('dl_1', ?, 'a-gh', ?, 'github', 'started')").bind(t.id, NOW).run();
    await runClock(NOW + 2 * DAY);
    expect(emails(calls).filter((m) => /How was/.test(m.subject))).toHaveLength(0);
    await runClock(NOW + 3 * DAY + MIN);
    await runClock(NOW + 3 * DAY + 2 * MIN);
    expect(emails(calls).filter((m) => /How was/.test(m.subject))).toHaveLength(1);
  });

  it("no survey nudge once the tester has answered", async () => {
    const t = await activeTester("alpha", "a@example.com", calls);
    await env.DB.prepare("INSERT INTO downloads (id, tester_id, build_id, at, source, result) VALUES ('dl_1', ?, 'a-gh', ?, 'github', 'started')").bind(t.id, NOW).run();
    await post("/t/alpha/survey/s1", { csrf: t.csrf, build: "a-gh", fun: "4" }, t.cookie);
    await runClock(NOW + 3 * DAY + MIN);
    expect(emails(calls).filter((m) => /How was/.test(m.subject))).toHaveLength(0);
  });

  it("a beta ending in 3 days: one notice per tester", async () => {
    await activeTester("alpha", "a@example.com", calls);
    await runClock(NOW + 17 * DAY + MIN);
    await runClock(NOW + 17 * DAY + 2 * MIN);
    expect(emails(calls).filter((m) => /ends soon/.test(m.subject))).toHaveLength(1);
  });

  it("each kind can be turned off per beta (book: no new-build notices, no invite reminders)", async () => {
    await invited("book", "r@example.com", calls);
    await env.DB.prepare("INSERT INTO builds (id, beta_id, label, source, target, available_at, origin, created_at) VALUES ('bk', 'book', 'EPUB', 'link', 'https://example.com/b.epub', ?, 'api', ?)").bind(NOW, NOW).run();
    await runClock(NOW + 6 * DAY);
    expect(emails(calls).filter((m) => m.to === "r@example.com")).toHaveLength(1); // the invite only
  });
});

describe("Clock runs", () => {
  beforeEach(async () => {
    await resetAll();
  });

  it("sets the alarm first and persists hot state every run", async () => {
    fakeNet();
    const out = await runClock(NOW);
    expect(out.synced).toBe(true);
    expect(out.nextAt).toBe(NOW + 5 * MIN);
    const saved = await inClock((c) => JSON.parse(c.sql.exec("SELECT v FROM run WHERE k = 'hot'").toArray()[0].v));
    expect(saved.lastRunAt).toBe(NOW);
    expect(saved.fp.runs).toBe(1);
    expect((await rows("SELECT id FROM betas")).length).toBe(5);
    expect((await rows("SELECT id FROM builds")).length).toBe(5);
    // Hot state survives the in-memory copy being dropped.
    await inClock((c) => {
      c.hot = null;
    });
    await runClock(NOW + 5 * MIN);
    const again = await inClock((c) => c.hot);
    expect(again.fp.runs).toBe(2);
    expect(again.cfgHash).toBe(saved.cfgHash);
  });

  it("backs off on persistent failures instead of hot-looping", async () => {
    fakeNet();
    const boom = async () => {
      throw new Error("D1_ERROR: overloaded");
    };
    const stmt = { bind: () => stmt, first: boom, run: boom, all: boom, raw: boom };
    setEnv({ DB: { prepare: () => stmt, batch: boom } });
    const gaps = [];
    let t = NOW;
    for (let i = 0; i < 6; i++) {
      const out = await runClock(t);
      expect(out.error).toContain("overloaded");
      gaps.push((out.nextAt - t) / MIN);
      t = out.nextAt;
    }
    expect(gaps).toEqual([5, 10, 20, 40, 60, 60]);
    expect((await inClock((c) => c.hot)).failures).toBe(6);
  });

  it("ensureAlarm re-arms a missing alarm; /tick answers without data", async () => {
    fakeNet();
    await runClock(NOW);
    const r = await inClock(async (c) => {
      await c.ctx.storage.deleteAlarm();
      return c.ensureAlarm(NOW + MIN);
    });
    expect(r.rearmed).toBe(true);
    const tick = await get("/tick");
    expect(await tick.text()).toBe("ok\n");
  });

  it("groups owner notices into one send_email at most every 30 minutes", async () => {
    fakeNet();
    const mail = fakeEmail();
    setEnv({ EMAIL: mail.binding });
    await runClock(NOW);
    setNow(NOW + MIN);
    for (let i = 0; i < 3; i++) await apply("alpha", { email: `n${i}@example.com` }, { ip: `198.51.100.${i}` });
    await runClock(NOW + 31 * MIN);
    setNow(NOW + 35 * MIN);
    await apply("alpha", { email: "late@example.com" }, { ip: "198.51.100.77" });
    await runClock(NOW + 40 * MIN);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe("owner@example.com");
    await runClock(NOW + 62 * MIN);
    expect(mail.sent).toHaveLength(2);
  });
});

describe("perchlight-keys (service binding)", () => {
  it("issues a key after the claim, and revokes it with the tester", async () => {
    const keys = fakeKeys();
    await resetAll({ KEYS: keys.binding });
    const calls = await synced();
    const t = await activeTester("alpha", "a@example.com", calls);
    await runClock(NOW + MIN);
    expect(keys.calls).toHaveLength(1);
    expect(keys.calls[0].auth).toBe("Bearer keys-test-token-0123456789");
    expect(keys.calls[0].body).toEqual({ product: "alpha", edition: "beta", email: "a@example.com", name: "Ada Tester", source: "import", source_ref: `beta:alpha:${t.id}`, expires_days: 90, send_email: true, notes: "perchlight-beta" });
    expect((await rows("SELECT license_id, key_status FROM testers WHERE id = ?", t.id))[0]).toEqual({ license_id: "lic_abc123", key_status: "issued" });
    await api("POST", `testers/${t.id}/revoke`);
    await runClock(NOW + 2 * MIN);
    expect(keys.calls[1].url).toMatch(/\/api\/licenses\/lic_abc123\/revoke$/);
    expect(keys.calls[1].body).toEqual({ reason: "beta access revoked" });
    expect((await rows("SELECT key_status FROM testers WHERE id = ?", t.id))[0].key_status).toBe("revoked");
  });

  it("retries a failed key call with backoff, and the tester can claim before the key exists", async () => {
    const keys = fakeKeys(() => new Response("down", { status: 503 }));
    await resetAll({ KEYS: keys.binding });
    const calls = await synced();
    const t = await activeTester("alpha", "a@example.com", calls);
    expect(t.html).toContain("Your beta key: on its way");
    await runClock(NOW + MIN);
    await runClock(NOW + MIN + 30_000);
    expect(keys.calls).toHaveLength(1);
    await runClock(NOW + 2 * MIN + 1000);
    expect(keys.calls).toHaveLength(2);
    const d = await rows("SELECT status, attempts FROM deliveries WHERE kind = 'key_issue'");
    expect(d[0]).toEqual({ status: "retry", attempts: 2 });
  });

  it("without a service binding, keys wait (KEYS_URL needs the scoped token)", async () => {
    await resetAll({ KEYS: undefined, KEYS_URL: "https://keys.example.com" });
    const calls = await synced();
    await activeTester("alpha", "a@example.com", calls);
    await runClock(NOW + MIN);
    expect((await rows("SELECT status FROM deliveries WHERE kind = 'key_issue'"))[0].status).toBe("pending");
    const b = await api("GET", "betas");
    expect(b.data.warnings.join(" ")).toContain("service binding is required");
    void HOUR;
  });
});
