import { describe, it, expect, beforeEach } from "vitest";
import { resetAll, synced, rows, emails, runClock, activeTester, post, get, fakeKeys, linkIn, cookieOf, setNow, NOW, MIN, DAY, call, ORIGIN } from "./helpers.js";
import { SIGNIN_SENT_TEXT } from "../src/lib/pages.js";

describe("sessions and sign-in", () => {
  let calls;
  let t;
  beforeEach(async () => {
    await resetAll({ KEYS: fakeKeys().binding });
    calls = await synced();
    t = await activeTester("alpha", "ada@example.com", calls);
  });

  it("a tampered, foreign or expired cookie is refused", async () => {
    const [name, value] = t.cookie.split("=");
    const parts = value.split(".");
    const tampered = `${name}=${parts[0]}.${Number(parts[1]) + 1}.${parts[2]}.${parts[3]}`;
    expect((await get("/t/alpha", tampered)).status).toBe(303);
    const badSig = `${name}=${parts[0]}.${parts[1]}.${parts[2]}.${"A".repeat(43)}`;
    expect((await get("/t/alpha", badSig)).headers.get("Location")).toBe("/signin");
    expect((await get("/t/alpha", t.cookie)).status).toBe(200);
    setNow(NOW + 31 * DAY);
    expect((await get("/t/alpha", t.cookie)).status).toBe(303);
  });

  it("writes last_seen_day at most once a day", async () => {
    expect((await rows("SELECT last_seen_day FROM testers"))[0].last_seen_day).toBe("2026-11-02");
    setNow(NOW + DAY);
    await get("/t/alpha", t.cookie);
    expect((await rows("SELECT last_seen_day FROM testers"))[0].last_seen_day).toBe("2026-11-03");
  });

  it("POST /signin always answers 202 the same way; only an active tester gets a link", async () => {
    const a = await post("/signin", { email: "ada@example.com", beta: "alpha", "cf-turnstile-response": "ok" });
    const b = await post("/signin", { email: "nobody@example.com", beta: "alpha", "cf-turnstile-response": "ok" });
    const c = await post("/signin", { email: "ada@example.com", beta: "nope", "cf-turnstile-response": "ok" });
    const bodies = await Promise.all([a, b, c].map((r) => r.text()));
    expect([a.status, b.status, c.status]).toEqual([202, 202, 202]);
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain(SIGNIN_SENT_TEXT.slice(0, 30));
    await runClock(NOW + 2000);
    const sent = emails(calls).filter((m) => /Sign in/.test(m.subject));
    expect(sent.map((m) => m.to)).toEqual(["ada@example.com"]);
    const token = linkIn(sent[0].text, "s");
    // GET shows a button and changes nothing; the POST signs in, once.
    expect(await (await get(`/s/${token}`)).text()).toContain('<form method="post"');
    expect(await (await get(`/s/${token}`)).text()).toContain('<form method="post"');
    const s1 = await post(`/s/${token}`, {});
    expect(s1.status).toBe(303);
    expect(cookieOf(s1)).toMatch(/^pb_s=/);
    const s2 = await post(`/s/${token}`, {});
    expect(s2.status).toBe(200);
    expect(cookieOf(s2)).toBe(null);
  });

  it("sign-in links expire after 30 minutes", async () => {
    await post("/signin", { email: "ada@example.com", beta: "alpha", "cf-turnstile-response": "ok" });
    await runClock(NOW + 2000);
    const token = linkIn(emails(calls).filter((m) => /Sign in/.test(m.subject))[0].text, "s");
    setNow(NOW + 31 * MIN);
    expect(cookieOf(await post(`/s/${token}`, {}))).toBe(null);
  });

  it("sign-in: 1 per 10 minutes per email", async () => {
    for (let i = 0; i < 3; i++) await post("/signin", { email: "ada@example.com", beta: "alpha", "cf-turnstile-response": "ok" });
    await runClock(NOW + 2000);
    expect(emails(calls).filter((m) => /Sign in/.test(m.subject))).toHaveLength(1);
    expect(await rows("SELECT id FROM signins")).toHaveLength(1);
  });

  it("sign-in needs Turnstile", async () => {
    const r = await post("/signin", { email: "ada@example.com", beta: "alpha", "cf-turnstile-response": "bad" });
    expect(r.status).toBe(400);
    expect(await rows("SELECT id FROM signins")).toHaveLength(0);
  });

  it("tester POSTs need the Origin and the CSRF value", async () => {
    expect((await post("/t/me/reminders", { csrf: t.csrf, off: "1" }, t.cookie, { Origin: "https://evil.example" })).status).toBe(403);
    const noOrigin = await call("/t/me/reminders", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: t.cookie }, body: `csrf=${t.csrf}&off=1` });
    expect(noOrigin.status).toBe(403);
    expect((await post("/t/me/reminders", { csrf: "f".repeat(32), off: "1" }, t.cookie)).status).toBe(403);
    expect((await rows("SELECT reminders_off FROM testers"))[0].reminders_off).toBe(0);
    expect((await post("/t/me/reminders", { csrf: t.csrf, off: "1" }, t.cookie)).status).toBe(303);
    expect((await rows("SELECT reminders_off FROM testers"))[0].reminders_off).toBe(1);
    void ORIGIN;
  });
});
