import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { resetAll, synced, rows, api, activeTester, get, post, setNow, NOW, MIN, DAY, fakeKeys, call } from "./helpers.js";
import { checkLinkUrl } from "../src/lib/config.js";
import { DOWNLOAD_DENIED_TEXT } from "../src/lib/pages.js";

function links(html) {
  return Object.fromEntries([...html.matchAll(/href="(\/d\/([a-z0-9-]+)\?[^"]+)"/g)].map((m) => [m[2], m[1].replace(/&amp;/g, "&")]));
}

const denied = async (res) => res.status === 403 && (await res.text()).includes(DOWNLOAD_DENIED_TEXT.replace(/'/g, "&#39;"));

describe("downloads", () => {
  let calls;
  let t;
  beforeEach(async () => {
    await resetAll({ KEYS: fakeKeys().binding });
    calls = await synced({
      "https://api.github.com/repos/me/alpha-builds/releases/tags/v0.4.0": { status: 200, body: JSON.stringify({ assets: [{ id: 42, name: "Alpha-0.4.zip" }] }) },
      "https://api.github.com/repos/me/alpha-builds/releases/assets/42": { status: 302, headers: { Location: "https://objects.githubusercontent.com/signed?x=1" } },
    });
    t = await activeTester("alpha", "ada@example.com", calls);
  });

  it("lists available builds with per-tester signed links (not group or future builds)", () => {
    const l = links(t.html);
    expect(Object.keys(l).sort()).toEqual(["a-gh", "a-link", "a-r2"]);
    expect(l["a-link"]).toMatch(new RegExp(`^/d/a-link\\?t=${t.id}&exp=${NOW + 15 * MIN}&sig=[A-Za-z0-9_-]{43}$`));
  });

  it("link: 302 to the configured URL, logged", async () => {
    const res = await get(links(t.html)["a-link"]);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://example.com/alpha-0.4.zip");
    const d = await rows("SELECT tester_id, build_id, source, result FROM downloads");
    expect(d).toEqual([{ tester_id: t.id, build_id: "a-link", source: "link", result: "started" }]);
  });

  it("github: resolves the asset id once, then 302 to GitHub's URL with no file bytes", async () => {
    const res = await get(links(t.html)["a-gh"]);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://objects.githubusercontent.com/signed?x=1");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    expect((await rows("SELECT asset_id FROM builds WHERE id = 'a-gh'"))[0].asset_id).toBe(42);
    const gh = calls.filter((c) => c.url.startsWith("https://api.github.com/"));
    expect(gh.map((c) => c.url.split("/releases/")[1])).toEqual(["tags/v0.4.0", "assets/42"]);
    expect(gh[1].headers.get("Accept")).toBe("application/octet-stream");
    expect(gh[1].headers.get("Authorization")).toBe("Bearer github_pat_test");
    await get(links(t.html)["a-gh"]);
    expect(calls.filter((c) => c.url.includes("/tags/"))).toHaveLength(1);
  });

  it("github: a streamed 200 is passed through as an attachment", async () => {
    await env.DB.prepare("UPDATE builds SET asset_id = 7 WHERE id = 'a-gh'").run();
    const { fakeNet } = await import("./helpers.js");
    fakeNet({ "https://api.github.com/repos/me/alpha-builds/releases/assets/7": { status: 200, body: "ZIPDATA" } });
    const res = await get(links(t.html)["a-gh"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="Alpha-0.4.zip"');
    expect(await res.text()).toBe("ZIPDATA");
  });

  it("github: an upstream failure is logged and answers 'temporarily unavailable'", async () => {
    const { fakeNet } = await import("./helpers.js");
    fakeNet({ "https://api.github.com/": { status: 401 } });
    const res = await get(links(t.html)["a-gh"]);
    expect(res.status).toBe(503);
    expect((await rows("SELECT result FROM downloads"))[0].result).toBe("upstream_error");
    await get(links(t.html)["a-gh"]);
    expect(await rows("SELECT id FROM events WHERE kind = 'upstream_error'")).toHaveLength(1);
  });

  it("r2: streams from the binding, with Range support", async () => {
    await env.FILES.put("builds/alpha-0.4.zip", "0123456789");
    const res = await get(links(t.html)["a-r2"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="alpha-0.4.zip"');
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.text()).toBe("0123456789");
    const part = await call(links(t.html)["a-r2"], { headers: { Range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(await part.text()).toBe("2345");
  });

  it("fails with one uniform 403 after expiry, with altered parameters, after revoke and past the daily limit; every attempt is logged", async () => {
    const url = links(t.html)["a-link"];
    expect(await denied(await get(url.replace(/sig=./, "sig=A")))).toBe(true);
    expect(await denied(await get(url.replace("a-link", "a-r2")))).toBe(true);
    expect(await denied(await get(url.replace(/exp=(\d+)/, (m, e) => `exp=${Number(e) + 1}`)))).toBe(true);
    setNow(NOW + 16 * MIN);
    expect(await denied(await get(url))).toBe(true);
    setNow(NOW);
    for (let i = 0; i < 30; i++) expect((await get(url)).status).toBe(302);
    expect(await denied(await get(url))).toBe(true);
    await api("POST", `testers/${t.id}/revoke`);
    expect(await denied(await get(url))).toBe(true);
    const counts = Object.fromEntries((await rows("SELECT result, COUNT(*) AS n FROM downloads GROUP BY result")).map((r) => [r.result, r.n]));
    expect(counts).toEqual({ refused_invalid: 4, started: 30, refused_limit: 1, refused_revoked: 1 });
  });

  it("an unknown tester id gets the same 403 and writes nothing", async () => {
    const url = links(t.html)["a-link"].replace(t.id, "t_aaaaaaaaaaaaaaaa");
    expect(await denied(await get(url))).toBe(true);
    expect(await rows("SELECT id FROM downloads")).toHaveLength(0);
  });

  it("a terms change forces re-acceptance before the next download", async () => {
    const url = links(t.html)["a-link"];
    await env.DB.prepare("UPDATE testers SET terms_accepted_version = 'v0' WHERE id = ?").bind(t.id).run();
    expect(await denied(await get(url))).toBe(true);
    expect((await rows("SELECT result FROM downloads"))[0].result).toBe("refused_terms");
    const page = await (await get("/t/alpha", t.cookie)).text();
    expect(page).toContain("The terms have changed");
    const r = await post("/t/alpha/terms", { csrf: t.csrf, version: "v1", full_name: "Ada L", accept: "1" }, t.cookie);
    expect(r.status).toBe(303);
    expect((await get(url)).status).toBe(302);
    const acc = await rows("SELECT how, full_name FROM acceptances ORDER BY accepted_at, how");
    expect(acc.map((a) => a.how).sort()).toEqual(["invite", "re-accept"]);
  });

  it("group builds only for testers in the group", async () => {
    await env.DB.prepare("UPDATE testers SET groups = 'deck' WHERE id = ?").bind(t.id).run();
    const html = await (await get("/t/alpha", t.cookie)).text();
    expect(Object.keys(links(html))).toContain("a-deck");
  });

  it("refuses a link build pointing at a private address or this deployment", () => {
    expect(checkLinkUrl("http://127.0.0.1/", "beta.test").ok).toBe(false);
    expect(checkLinkUrl("https://127.0.0.1/", "beta.test").ok).toBe(false);
    expect(checkLinkUrl("https://10.1.2.3/x", "beta.test").ok).toBe(false);
    expect(checkLinkUrl("https://100.64.0.1/x", "beta.test").ok).toBe(false);
    expect(checkLinkUrl("https://[::1]/x", "beta.test").ok).toBe(false);
    expect(checkLinkUrl("https://localhost/x", "beta.test").ok).toBe(false);
    expect(checkLinkUrl("https://printer.local/x", "beta.test").ok).toBe(false);
    expect(checkLinkUrl("https://user:pw@example.com/x", "beta.test").ok).toBe(false);
    expect(checkLinkUrl("https://beta.test/d/x", "beta.test").ok).toBe(false);
    expect(checkLinkUrl("https://store.steampowered.com/app/1/", "beta.test").ok).toBe(true);
  });

  it("POST /api/builds refuses http://127.0.0.1/ and the deployment's own host", async () => {
    const a = await api("POST", "builds", { id: "x1", beta: "alpha", label: "x", source: "link", url: "http://127.0.0.1/" });
    expect(a.status).toBe(400);
    const b = await api("POST", "builds", { id: "x2", beta: "alpha", label: "x", source: "link", url: "https://beta.test/anything" });
    expect(b.status).toBe(400);
    const c = await api("POST", "builds", { id: "x3", beta: "alpha", label: "Extra", source: "link", url: "https://example.org/x.zip" });
    expect(c.status).toBe(201);
    const html = await (await get("/t/alpha", t.cookie)).text();
    expect(Object.keys(links(html))).toContain("x3");
  });

  it("downloads stop after a closed beta's grace period", async () => {
    await api("POST", "betas/alpha/close");
    setNow(NOW + 8 * DAY);
    const html = await (await get("/t/alpha", t.cookie)).text();
    expect(html).toContain("downloads are closed");
  });
});
