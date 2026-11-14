import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { resetAll, synced, rows, api, call, activeTester, apply, get, fakeKeys, setEnv, runClock, NOW, MIN } from "./helpers.js";
import { checkConfig, MAX_BETAS } from "../src/lib/config.js";
import shipped from "../beta.json";
import nda from "../terms/hollow-lantern-nda.md?raw";
import arc from "../terms/arc.md?raw";

describe("admin auth", () => {
  beforeEach(async () => {
    await resetAll();
    await synced();
  });

  it("needs the bearer token, compared in constant time", async () => {
    expect((await call("/api/betas")).status).toBe(401);
    expect((await api("GET", "betas", undefined, "wrong-token-0123456789")).status).toBe(401);
    expect((await api("GET", "betas", undefined, "test-admin-token-012345678")).status).toBe(401);
    expect((await api("GET", "betas")).status).toBe(200);
  });

  it("refuses everything while ADMIN_TOKEN is under 16 characters", async () => {
    setEnv({ ADMIN_TOKEN: "short" });
    expect((await api("GET", "betas", undefined, "short")).status).toBe(503);
  });

  it("unknown endpoints are 404, bodies over 32 KB are refused", async () => {
    expect((await api("GET", "nope")).status).toBe(404);
    const big = await api("POST", "applications/decide", { ids: ["x".repeat(40 * 1024)], action: "approve" });
    expect(big.status).toBe(400);
  });
});

describe("admin API", () => {
  let calls;
  beforeEach(async () => {
    await resetAll({ KEYS: fakeKeys().binding });
    calls = await synced();
  });

  it("GET /api/betas lists betas, counts, errors and warnings", async () => {
    await apply("alpha", { email: "a@example.com" });
    const r = await api("GET", "betas");
    const alpha = r.data.betas.find((b) => b.id === "alpha");
    expect(alpha).toMatchObject({ status: "open", config_error: null, counts: { applied: 1 } });
    expect(r.data.warnings.some((w) => /full ADMIN_TOKEN/.test(w))).toBe(true);
    expect(r.data.estimate.emailsPerDayAtBusiest).toBeGreaterThan(0);
  });

  it("dashboard: per beta, per build, not downloaded, no feedback, by source", async () => {
    const t = await activeTester("alpha", "a@example.com", calls);
    await activeTester("alpha", "b@example.com", calls);
    const html = await (await get("/t/alpha", t.cookie)).text();
    await get(/href="(\/d\/a-link\?[^"]+)"/.exec(html)[1].replace(/&amp;/g, "&"));
    const d = await api("GET", "dashboard?beta=alpha");
    const b = d.data.betas[0];
    expect(b.active).toBe(2);
    expect(b.builds.find((x) => x.id === "a-link")).toMatchObject({ downloads: 1, testers: 1 });
    expect(b.not_downloaded.map((x) => x.id)).not.toContain(t.id);
    expect(b.not_downloaded).toHaveLength(1);
    expect(b.downloaded_no_feedback.map((x) => x.id)).toEqual([t.id]);
    expect(b.by_source[0]).toMatchObject({ applications: 2, approved: 2 });
    const acc = await api("GET", "acceptances?beta=alpha");
    expect(acc.data.acceptances).toHaveLength(2);
    const dl = await api("GET", "downloads?beta=alpha");
    expect(dl.data.downloads[0].reader_code).toMatch(/^[0-9A-Z]{8}$/);
  });

  it("GET /api/footprint after a busy day stays under 2,000 D1 rows written and 400 Clock runs", async () => {
    for (let i = 0; i < 10; i++) await apply("alpha", { email: `f${i}@example.com` }, { ip: `198.51.100.${i}` });
    const t = await activeTester("alpha", "busy@example.com", calls);
    for (let i = 0; i < 5; i++) await runClock(NOW + i * 5 * MIN);
    const f = await api("GET", "footprint");
    expect(f.data.d1.est_rows_written).toBeLessThan(2000);
    expect(f.data.clock.runs).toBeLessThan(400);
    expect(f.data.d1.rows_created.testers).toBe(11);
    void t;
  });

  it("builds API: GET, PATCH an api build, refuse PATCH of a config build, resolve a GitHub asset", async () => {
    await api("POST", "builds", { id: "x1", beta: "alpha", label: "Extra", source: "link", url: "https://example.org/x.zip" });
    expect((await api("PATCH", "builds/x1", { label: "Extra 2", url: "http://127.0.0.1/" })).status).toBe(400);
    expect((await api("PATCH", "builds/x1", { label: "Extra 2" })).data.build.label).toBe("Extra 2");
    expect((await api("PATCH", "builds/a-link", { label: "x" })).status).toBe(409);
    const { fakeNet } = await import("./helpers.js");
    fakeNet({ "https://api.github.com/": { status: 200, body: JSON.stringify({ assets: [{ id: 9, name: "Alpha-0.4.zip" }] }) } });
    expect((await api("POST", "builds/a-gh/resolve")).data.asset_id).toBe(9);
    expect((await api("GET", "builds?beta=alpha")).data.builds.length).toBe(6);
  });

  it("deliveries: list and retry a failed one", async () => {
    await env.DB.prepare("INSERT INTO deliveries (id, kind, tester_id, beta_id, ref, dedupe, priority, status, attempts, next_at, created_at) VALUES ('d_failedfailedfail', 'invite', NULL, 'alpha', NULL, 'x', 1, 'failed', 5, 0, 0)").run();
    expect((await api("GET", "deliveries?status=failed")).data.deliveries).toHaveLength(1);
    expect((await api("POST", "deliveries/d_failedfailedfail/retry")).data.retried).toBe(true);
    expect((await rows("SELECT status FROM deliveries"))[0].status).toBe("pending");
  });

  it("POST /api/housekeeping runs Clock now", async () => {
    const r = await api("POST", "housekeeping");
    expect(r.data.ok).toBe(true);
    expect(r.data.run.error).toBe(null);
  });
});

describe("config check", () => {
  const beta = (i) => [`b${i}`, { name: `B${i}`, status: "open", terms: { text: "t", version: "1" } }];

  it("allows at most 10 betas; the rest are switched off with a reason", () => {
    const c = checkConfig({ betas: Object.fromEntries(Array.from({ length: 12 }, (_, i) => beta(i))) });
    expect(MAX_BETAS).toBe(10);
    expect(c.byId.size).toBe(10);
    expect(c.betas.filter((b) => b.error)).toHaveLength(2);
    expect(c.errors[0]).toContain("at most 10 betas");
  });

  it("switches off one bad beta or build and keeps the rest", () => {
    const c = checkConfig({
      betas: {
        good: { name: "Good", terms: { text: "t", version: "1" } },
        noterms: { name: "No terms" },
        badq: { name: "Bad", terms: { text: "t", version: "1" }, questions: [{ id: "name", type: "text", label: "x" }] },
        many: { name: "Many", terms: { text: "t", version: "1" }, questions: Array.from({ length: 21 }, (_, i) => ({ id: `q${i}`, type: "text", label: "x" })) },
      },
      builds: {
        ok: { beta: "good", label: "OK", url: "https://example.com/x" },
        local: { beta: "good", label: "L", url: "http://127.0.0.1/" },
        orphan: { beta: "noterms", label: "O", url: "https://example.com/x" },
        gh: { beta: "good", label: "G", source: "github", repo: "bad repo", tag: "v1", asset: "a" },
      },
      email: { dailyCap: 150 },
    });
    expect([...c.byId.keys()]).toEqual(["good"]);
    expect(c.betas.find((b) => b.id === "badq").error).toContain("isn't allowed");
    expect(c.betas.find((b) => b.id === "many").error).toContain("at most 20");
    expect([...c.buildById.keys()]).toEqual(["ok"]);
    expect(c.errors.join(" ")).toContain("above Resend's free plan");
  });

  it("the shipped beta.json is valid", () => {
    const c = checkConfig(shipped, { terms: { "terms/hollow-lantern-nda.md": nda, "terms/arc.md": arc }, ownHost: "beta.example.com" });
    expect(c.betas.filter((b) => b.error)).toEqual([]);
    expect(c.builds.filter((b) => b.error)).toEqual([]);
    expect(c.errors).toEqual([]);
    expect(c.email).toEqual({ dailyCap: 90, monthlyCap: 2800 });
    expect(c.screenshots).toEqual({ store: "d1", maxBytes: 400 * 1024, perBug: 2, totalCap: 150 * 1024 * 1024 });
  });
});
