import { describe, it, expect, beforeEach } from "vitest";
import { resetAll, synced, apply, rows, testerId, api, call, setEnv, fakeNet, get } from "./helpers.js";

async function snapshot(res) {
  const headers = [...res.headers.entries()].sort();
  return { status: res.status, headers, body: await res.text() };
}

describe("apply", () => {
  beforeEach(async () => {
    await resetAll();
    await synced();
  });

  it("answers byte-identically for new, repeat, closed-beta waitlist and blocked applications", async () => {
    const a = await snapshot(await apply("alpha", { email: "new@example.com" }));
    const b = await snapshot(await apply("alpha", { email: "new@example.com", why: "updated answer" }));
    const c = await snapshot(await apply("shut", { email: "wait@example.com", platform: undefined }));
    // blocked
    await apply("alpha", { email: "bad@example.com" });
    const id = await testerId("alpha", "bad@example.com");
    await api("POST", "applications/decide", { ids: [id], action: "block" });
    const d = await snapshot(await apply("alpha", { email: "bad@example.com", why: "again" }));
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(d).toEqual(a);
    expect(a.status).toBe(200);
    const mine = await rows("SELECT answers, status FROM testers WHERE beta_id = 'alpha' AND email = 'new@example.com'");
    expect(mine).toHaveLength(1);
    expect(JSON.parse(mine[0].answers).why).toBe("updated answer");
    expect((await rows("SELECT status FROM testers WHERE beta_id = 'shut'"))[0].status).toBe("waitlisted");
    const blocked = await rows("SELECT status, answers FROM testers WHERE id = ?", id);
    expect(blocked[0].status).toBe("blocked");
    expect(JSON.parse(blocked[0].answers).why).toBeUndefined();
  });

  it("stores nothing without a valid Turnstile token, and stores the same request with one", async () => {
    const r1 = await apply("alpha", { email: "t@example.com", "cf-turnstile-response": "" });
    expect(r1.status).toBe(400);
    const r2 = await apply("alpha", { email: "t@example.com", "cf-turnstile-response": "bad" });
    expect(r2.status).toBe(400);
    expect(await rows("SELECT id FROM testers")).toHaveLength(0);
    const r3 = await apply("alpha", { email: "t@example.com" });
    expect(r3.status).toBe(200);
    expect(await rows("SELECT id FROM testers")).toHaveLength(1);
  });

  it("fails closed when siteverify is unreachable", async () => {
    fakeNet({ "https://challenges.cloudflare.com/": "down" });
    expect((await apply("alpha", { email: "x@example.com" })).status).toBe(400);
    expect(await rows("SELECT id FROM testers")).toHaveLength(0);
  });

  it("drops a honeypot submission with the same thanks", async () => {
    const ok = await (await apply("alpha", { email: "a@example.com" })).text();
    const hp = await apply("alpha", { email: "bot@example.com", website: "http://spam" });
    expect(await hp.text()).toBe(ok);
    expect(await rows("SELECT id FROM testers WHERE email = 'bot@example.com'")).toHaveLength(0);
  });

  it("validates answers and limits", async () => {
    const r = await apply("alpha", { email: "v@example.com", platform: ["Linux"], why: "x".repeat(101), hours: "200" });
    expect(r.status).toBe(400);
    const html = await r.text();
    expect(html).toContain("not one of the options");
    expect(html).toContain("at most 100 characters");
    expect(html).toContain("a number from 0 to 80");
    expect((await apply("alpha", { email: "v@example.com", platform: undefined })).status).toBe(400);
    expect((await apply("alpha", { email: "not-an-email" })).status).toBe(400);
    expect((await apply("alpha", { email: "v@example.com", name: "n".repeat(101) })).status).toBe(400);
    expect(await rows("SELECT id FROM testers")).toHaveLength(0);
  });

  it("refuses a body over 32 KB before reading it", async () => {
    const res = await call("/b/alpha/apply", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(40 * 1024) }, body: "name=x" });
    expect(res.status).toBe(413);
    const big = await apply("alpha", { email: "big@example.com", why: "y".repeat(40 * 1024) });
    expect(big.status).toBe(413);
  });

  it("rate-limits 5 applications an hour per IP", async () => {
    for (let i = 0; i < 5; i++) expect((await apply("alpha", { email: `r${i}@example.com` })).status).toBe(200);
    expect((await apply("alpha", { email: "r6@example.com" })).status).toBe(429);
    expect((await apply("alpha", { email: "r7@example.com" }, { ip: "198.51.100.7" })).status).toBe(200);
  });

  it("stores only allowed ?src= values", async () => {
    await apply("alpha", { email: "s1@example.com", src: "list" });
    await apply("alpha", { email: "s2@example.com", src: "evil" });
    const r = await rows("SELECT email, src FROM testers ORDER BY email");
    expect(r).toEqual([{ email: "s1@example.com", src: "list" }, { email: "s2@example.com", src: null }]);
    const page = await (await get("/b/alpha?src=list")).text();
    expect(page).toContain('name="src" value="list"');
    expect(await (await get("/b/alpha?src=evil")).text()).not.toContain('name="src"');
  });

  it("shows one 'not open' page for draft and unknown betas", async () => {
    const a = await (await get("/b/hidden")).text();
    const b = await (await get("/b/nope")).text();
    expect(a).toBe(b);
    expect(a).toContain("isn&#39;t taking applications");
    expect(await (await apply("hidden", { email: "h@example.com" })).text()).toBe(a);
    expect(await rows("SELECT id FROM testers")).toHaveLength(0);
  });

  it("answers 503 when D1 can't store the application", async () => {
    const boom = async () => {
      throw new Error("D1_ERROR: writes are blocked");
    };
    const stmt = { bind: () => stmt, first: async () => null, run: boom, all: async () => ({ results: [] }), raw: boom };
    setEnv({ DB: { prepare: () => stmt, batch: boom } });
    const r = await apply("alpha", { email: "d1@example.com" });
    expect(r.status).toBe(503);
  });

  it("sets the security headers on pages", async () => {
    const r = await get("/b/alpha");
    expect(r.headers.get("X-Frame-Options")).toBe("DENY");
    expect(r.headers.get("Referrer-Policy")).toBe("no-referrer");
    const csp = r.headers.get("Content-Security-Policy");
    expect(csp).toContain("script-src https://challenges.cloudflare.com");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("refuses a URL over 2 KB", async () => {
    expect((await get(`/b/alpha?x=${"a".repeat(2100)}`)).status).toBe(414);
  });
});
