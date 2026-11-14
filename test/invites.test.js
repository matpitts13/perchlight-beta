import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { resetAll, synced, apply, rows, testerId, api, emails, runClock, invited, claim, get, post, csrfOf, linkIn, NOW, DAY, MIN, cookieOf, setEnv, fakeKeys } from "./helpers.js";
import { ALPHA_TERMS } from "./config.js";
import { sha256Hex } from "../src/lib/crypto.js";
import { INVITE_DEAD_TEXT } from "../src/lib/pages.js";

const dead = (html) => html.includes(INVITE_DEAD_TEXT.replace(/'/g, "&#39;"));

describe("approve and invite", () => {
  let calls;
  beforeEach(async () => {
    await resetAll({ KEYS: fakeKeys().binding });
    calls = await synced();
  });

  it("an app action (action_requested) sends one invite on the next Clock run", async () => {
    await apply("alpha", { email: "ada@example.com" });
    const id = await testerId("alpha", "ada@example.com");
    await env.DB.prepare("UPDATE testers SET action_requested = 'approve' WHERE id = ?").bind(id).run();
    const out = await runClock(NOW + 5 * MIN);
    expect(out.actions).toBe(1);
    const sent = emails(calls).filter((m) => m.to === "ada@example.com");
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("invited");
    expect(sent[0].key).toMatch(/^beta-d_/);
    const inv = await rows("SELECT status, token_hash, expires_at, sent_at FROM invites WHERE tester_id = ?", id);
    expect(inv).toHaveLength(1);
    expect(inv[0].status).toBe("sent");
    expect(inv[0].expires_at - inv[0].sent_at).toBe(14 * DAY);
    const token = linkIn(sent[0].text, "i");
    expect(inv[0].token_hash).toBe(await sha256Hex(token));
    expect((await rows("SELECT status, action_requested FROM testers WHERE id = ?", id))[0]).toEqual({ status: "invited", action_requested: null });
    // A second run sends nothing more.
    await runClock(NOW + 10 * MIN);
    expect(emails(calls).filter((m) => m.to === "ada@example.com")).toHaveLength(1);
  });

  it("GET ten times changes nothing; one POST claims; a second gives the uniform page", async () => {
    const { id, token } = await invited("alpha", "ada@example.com", calls);
    const before = JSON.stringify(await rows("SELECT * FROM invites"));
    for (let i = 0; i < 10; i++) {
      const r = await get(`/i/${token}`);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain("Accept and continue");
    }
    expect(JSON.stringify(await rows("SELECT * FROM invites"))).toBe(before);
    const first = await claim(token, { name: "Ada Lovelace" });
    expect(first.res.status).toBe(303);
    expect(first.res.headers.get("Location")).toBe("/t/alpha");
    expect(first.res.headers.get("Set-Cookie")).toMatch(/^pb_s=.+; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    const second = await post(`/i/${token}/claim`, { csrf: first.csrf, version: "v1", full_name: "Mallory", accept: "1" });
    expect(dead(await second.text())).toBe(true);
    // With the winner's session, a replay goes to the tester page.
    const replay = await post(`/i/${token}/claim`, { csrf: first.csrf, version: "v1", full_name: "Ada", accept: "1" }, first.cookie);
    expect(replay.status).toBe(303);
    expect(replay.headers.get("Location")).toBe("/t");
    const acc = await rows("SELECT * FROM acceptances");
    expect(acc).toHaveLength(1);
    expect(acc[0]).toMatchObject({ tester_id: id, beta_id: "alpha", version: "v1", text_sha256: await sha256Hex(ALPHA_TERMS), full_name: "Ada Lovelace", how: "invite", accepted_at: NOW });
    expect((await rows("SELECT status, terms_accepted_version FROM testers WHERE id = ?", id))[0]).toEqual({ status: "active", terms_accepted_version: "v1" });
  });

  it("two claims at once: exactly one wins", async () => {
    const { token } = await invited("alpha", "ada@example.com", calls);
    const html = await (await get(`/i/${token}`)).text();
    const csrf = csrfOf(html);
    const res = await Promise.all([1, 2, 3].map((i) => post(`/i/${token}/claim`, { csrf, version: "v1", full_name: `Racer ${i}`, accept: "1" })));
    expect(res.filter((r) => r.status === 303)).toHaveLength(1);
    expect(await rows("SELECT id FROM acceptances")).toHaveLength(1);
  });

  it("expired, revoked, unknown and malformed tokens all get the same page", async () => {
    const a = await invited("alpha", "a@example.com", calls);
    const b = await invited("alpha", "b@example.com", calls);
    const inv = await rows("SELECT id FROM invites WHERE tester_id = ?", b.id);
    expect((await api("POST", `invites/${inv[0].id}/revoke`)).data.revoked).toBe(true);
    const pages = await Promise.all([get("/i/AAAAAAAAAAAAAAAAAAAAAA"), get("/i/short"), get(`/i/${b.token}`)].map(async (p) => (await p).text()));
    expect(new Set(pages).size).toBe(1);
    expect(dead(pages[0])).toBe(true);
    // Expiry: past expires_at the GET and the POST both fail; Clock marks it expired.
    const html = await (await get(`/i/${a.token}`)).text();
    await runClock(NOW + 15 * DAY);
    expect(await (await get(`/i/${a.token}`)).text()).toBe(pages[0]);
    const r = await post(`/i/${a.token}/claim`, { csrf: csrfOf(html), version: "v1", full_name: "Late", accept: "1" });
    expect(await r.text()).toBe(pages[0]);
    expect((await rows("SELECT status FROM invites WHERE tester_id = ?", a.id))[0].status).toBe("expired");
  });

  it("a re-sent invite replaces the old token", async () => {
    const { id, token } = await invited("alpha", "ada@example.com", calls);
    const inv = await rows("SELECT id FROM invites WHERE tester_id = ?", id);
    const r = await api("POST", `invites/${inv[0].id}/resend`);
    expect(r.data.invites).toBe(1);
    await runClock(NOW + MIN);
    const sent = emails(calls).filter((m) => m.to === "ada@example.com");
    expect(sent).toHaveLength(2);
    const fresh = linkIn(sent[1].text, "i");
    expect(fresh).not.toBe(token);
    expect(dead(await (await get(`/i/${token}`)).text())).toBe(true);
    expect((await claim(fresh)).res.status).toBe(303);
  });

  it("terms changed after the page was shown: nothing is claimed and the new text shows", async () => {
    const { id, token } = await invited("alpha", "ada@example.com", calls);
    const res = (await claim(token, { version: "v0" })).res;
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("The terms have changed");
    expect((await rows("SELECT status FROM invites WHERE tester_id = ?", id))[0].status).toBe("sent");
    expect(await rows("SELECT id FROM acceptances")).toHaveLength(0);
  });

  it("refuses a claim without Origin, with a bad CSRF value, or without accepting", async () => {
    const { token } = await invited("alpha", "ada@example.com", calls);
    const html = await (await get(`/i/${token}`)).text();
    const csrf = csrfOf(html);
    expect((await post(`/i/${token}/claim`, { csrf, version: "v1", full_name: "A", accept: "1" }, null, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post(`/i/${token}/claim`, { csrf: "0".repeat(32), version: "v1", full_name: "A", accept: "1" })).status).toBe(403);
    expect((await post(`/i/${token}/claim`, { csrf, version: "v1", full_name: "A" })).status).toBe(400);
    expect((await post(`/i/${token}/claim`, { csrf, version: "v1", full_name: "", accept: "1" })).status).toBe(400);
    expect((await rows("SELECT status FROM invites"))[0].status).toBe("sent");
  });

  it("a manual invite (POST /api/invites)", async () => {
    const r = await api("POST", "invites", { beta: "alpha", email: "Friend@Example.com", name: "Friend" });
    expect(r.status).toBe(201);
    expect(r.data.email.summary).toBe("1 invite: sent today");
    await runClock(NOW + MIN);
    expect(emails(calls).filter((m) => m.to === "friend@example.com")).toHaveLength(1);
    const again = await api("POST", "invites", { beta: "alpha", email: "friend@example.com" });
    expect(again.status).toBe(409);
  });

  it("maxTesters reached: further approvals go on the waitlist with a note", async () => {
    for (const e of ["s1@example.com", "s2@example.com", "s3@example.com"]) await apply("small", { email: e, platform: undefined });
    const ids = await Promise.all(["s1@example.com", "s2@example.com", "s3@example.com"].map((e) => testerId("small", e)));
    const r = await api("POST", "applications/decide", { ids, action: "approve" });
    expect(r.data).toMatchObject({ changed: 2, invites: 2, waitlisted: 1 });
    const w = await rows("SELECT status, note FROM testers WHERE id = ?", ids[2]);
    expect(w[0].status).toBe("waitlisted");
    expect(w[0].note).toContain("maxTesters");
  });

  it("decline, waitlist and block in bulk", async () => {
    for (const e of ["d1@example.com", "d2@example.com"]) await apply("alpha", { email: e });
    const ids = await Promise.all(["d1@example.com", "d2@example.com"].map((e) => testerId("alpha", e)));
    expect((await api("POST", "applications/decide", { ids, action: "decline" })).data.changed).toBe(2);
    expect((await api("POST", "applications/decide", { ids: [ids[0]], action: "waitlist" })).data.changed).toBe(1);
    expect((await api("POST", "applications/decide", { ids, action: "frobnicate" })).status).toBe(400);
    const list = await api("GET", "applications?beta=alpha");
    expect(list.data.applications.map((a) => a.status)).toEqual(["waitlisted"]);
  });

  it("a claim sets a working session cookie", async () => {
    const { token } = await invited("alpha", "ada@example.com", calls);
    const { res } = await claim(token);
    const page = await get("/t/alpha", cookieOf(res));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Signed in as Ada Tester");
    setEnv({});
  });
});
