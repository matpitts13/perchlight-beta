import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { resetAll, synced, rows, api, emails, runClock, activeTester, post, get, fakeKeys, ORIGIN, call, NOW, MIN, DAY, setNow } from "./helpers.js";

function png(size) {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b;
}

async function busyTester(calls) {
  const t = await activeTester("alpha", "ada@example.com", calls);
  await post("/t/alpha/survey/s1", { csrf: t.csrf, build: "a-gh", fun: "4" }, t.cookie);
  const fd = new FormData();
  fd.set("csrf", t.csrf);
  fd.set("title", "Bug");
  fd.set("body", "Steps");
  fd.append("screenshot", new File([png(1000)], "a.png", { type: "image/png" }));
  await call("/t/alpha/bugs", { method: "POST", headers: { Origin: ORIGIN, Cookie: t.cookie }, body: fd });
  const html = await (await get("/t/alpha", t.cookie)).text();
  const link = /href="(\/d\/a-link\?[^"]+)"/.exec(html)[1].replace(/&amp;/g, "&");
  await get(link);
  return t;
}

describe("export and delete", () => {
  let calls;
  let keys;
  beforeEach(async () => {
    keys = fakeKeys();
    await resetAll({ KEYS: keys.binding });
    calls = await synced();
  });

  it("GET /t/me/export returns every row tied to the tester, across betas", async () => {
    const t = await busyTester(calls);
    // The same person in a second beta.
    await activeTester("book", "ada@example.com", calls);
    const res = await get("/t/me/export", t.cookie);
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="perchlight-beta-export-2026-11-02\.json"$/);
    const data = await res.json();
    expect(data.testers.map((x) => x.beta_id).sort()).toEqual(["alpha", "book"]);
    expect(data.invites).toHaveLength(2);
    expect(data.acceptances).toHaveLength(2);
    expect(data.responses[0].answers).toEqual({ fun: 4 });
    expect(data.bugs).toHaveLength(1);
    expect(data.bug_images).toEqual([{ bug_id: data.bugs[0].id, n: 1, mime: "image/png", size: 1000 }]);
    expect(data.downloads).toHaveLength(1);
    expect(data.deliveries.length).toBeGreaterThan(0);
    expect(JSON.stringify(data)).not.toContain("email_hmac");
    expect(JSON.stringify(data)).not.toContain("token_hash");
  });

  it("POST /t/me/delete removes everything but the pseudonymised acceptance (kept 730 days)", async () => {
    const t = await busyTester(calls);
    await runClock(NOW + MIN); // the key is issued
    const res = await post("/t/me/delete", { csrf: t.csrf }, t.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    for (const table of ["testers", "invites", "signins", "downloads", "responses", "bugs", "bug_images"]) {
      expect(await rows(`SELECT * FROM ${table}`), table).toHaveLength(0);
    }
    expect(await rows("SELECT id FROM events WHERE tester_id IS NOT NULL")).toHaveLength(0);
    expect(await rows("SELECT id FROM deliveries WHERE tester_id IS NOT NULL")).toHaveLength(0);
    const acc = await rows("SELECT tester_id, full_name, email_hmac, version, text_sha256, accepted_at, delete_after FROM acceptances");
    expect(acc).toHaveLength(1);
    expect(acc[0]).toMatchObject({ tester_id: null, full_name: null, version: "v1", accepted_at: NOW, delete_after: NOW + MIN + 730 * DAY });
    expect(acc[0].email_hmac).toMatch(/^[a-f0-9]{64}$/);
    expect(acc[0].text_sha256).toMatch(/^[a-f0-9]{64}$/);
    // The key is revoked in perchlight-keys.
    await runClock(NOW + 2 * MIN);
    expect(keys.calls.at(-1).url).toMatch(/lic_abc123\/revoke$/);
    // The old cookie no longer works.
    const page = await get("/t/alpha", t.cookie);
    expect(page.status).toBe(303);
    expect(page.headers.get("Location")).toBe("/signin?ended=1");
    // Retention removes the pseudonymised acceptance after 730 days.
    await runClock(NOW + 731 * DAY);
    expect(await rows("SELECT id FROM acceptances")).toHaveLength(0);
  });

  it("the acceptance log is append-only", async () => {
    await activeTester("alpha", "ada@example.com", calls);
    await expect(env.DB.prepare("UPDATE acceptances SET version = 'v9'").run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("UPDATE acceptances SET full_name = 'Someone else'").run()).rejects.toThrow(/pseudonymised/);
  });

  it("admin export and delete for one tester", async () => {
    const t = await busyTester(calls);
    const ex = await api("GET", `testers/${t.id}/export`);
    expect(ex.data.testers[0].id).toBe(t.id);
    const del = await api("DELETE", `testers/${t.id}`);
    expect(del.data.deleted).toBe(1);
    expect(await rows("SELECT id FROM testers")).toHaveLength(0);
    expect(await rows("SELECT tester_id FROM acceptances")).toEqual([{ tester_id: null }]);
  });

  it("withdraw ends access and keeps the record", async () => {
    const t = await activeTester("alpha", "ada@example.com", calls);
    const r = await post("/t/alpha/withdraw", { csrf: t.csrf }, t.cookie);
    expect(r.status).toBe(200);
    expect((await rows("SELECT status FROM testers"))[0].status).toBe("withdrawn");
    expect((await get("/t/alpha", t.cookie)).status).toBe(303);
  });

  it("retention: declined applicants go after 30 days; blocked ones keep only the email HMAC", async () => {
    const { apply, testerId } = await import("./helpers.js");
    await apply("alpha", { email: "no@example.com" });
    await apply("alpha", { email: "spam@example.com" }, { ip: "198.51.100.2" });
    const no = await testerId("alpha", "no@example.com");
    const spam = await testerId("alpha", "spam@example.com");
    await api("POST", "applications/decide", { ids: [no], action: "decline" });
    await api("POST", "applications/decide", { ids: [spam], action: "block" });
    await runClock(NOW + 29 * DAY);
    expect(await rows("SELECT id FROM testers WHERE id = ?", no)).toHaveLength(1);
    await runClock(NOW + 31 * DAY);
    expect(await rows("SELECT id FROM testers WHERE id = ?", no)).toHaveLength(0);
    const b = await rows("SELECT email, name, answers, status, email_hmac FROM testers WHERE id = ?", spam);
    expect(b[0]).toMatchObject({ email: "", name: null, answers: null, status: "blocked" });
    expect(b[0].email_hmac).toMatch(/^[a-f0-9]{64}$/);
    // Still blocked: a new application from that address isn't stored.
    setNow(NOW + 31 * DAY);
    await apply("alpha", { email: "spam@example.com" }, { ip: "198.51.100.3" });
    expect((await rows("SELECT email, status FROM testers WHERE id = ?", spam))[0]).toEqual({ email: "", status: "blocked" });
    void emails;
  });

  it("retention after a beta closes: testers deleted after afterCloseDays, acceptances pseudonymised", async () => {
    await activeTester("alpha", "ada@example.com", calls);
    await api("POST", "betas/alpha/close");
    await runClock(NOW + 181 * DAY);
    expect(await rows("SELECT id FROM testers WHERE beta_id = 'alpha'")).toHaveLength(0);
    expect((await rows("SELECT tester_id, full_name FROM acceptances"))[0]).toEqual({ tester_id: null, full_name: null });
  });
});

describe("revoke", () => {
  it("the tester's next request goes to sign-in, sign-in sends nothing, open invites and links stop", async () => {
    await resetAll({ KEYS: fakeKeys().binding });
    const calls = await synced();
    const t = await activeTester("alpha", "ada@example.com", calls);
    const r = await api("POST", `testers/${t.id}/revoke`);
    expect(r.data.changed).toBe(1);
    const page = await get("/t/alpha", t.cookie);
    expect(page.status).toBe(303);
    expect(page.headers.get("Location")).toBe("/signin?ended=1");
    const before = emails(calls).length;
    const s = await post("/signin", { email: "ada@example.com", beta: "alpha", "cf-turnstile-response": "ok" });
    expect(s.status).toBe(202);
    await runClock(NOW + MIN);
    expect(emails(calls).slice(before).filter((m) => /Sign in/.test(m.subject))).toHaveLength(0);
    expect((await rows("SELECT status, session_ver FROM testers"))[0]).toEqual({ status: "revoked", session_ver: 2 });
  });
});
