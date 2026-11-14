import { describe, it, expect, beforeEach } from "vitest";
import { resetAll, synced, rows, api, activeTester, post, call, ORIGIN, fakeKeys, setNow, NOW, MIN } from "./helpers.js";
import { sniffImage } from "../src/lib/images.js";

const KB = 1024;
function png(size) {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b;
}
function jpeg(size) {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
}

function bug(t, files = [], fields = {}) {
  const fd = new FormData();
  fd.set("csrf", t.csrf);
  fd.set("title", fields.title ?? "Crash on load");
  fd.set("body", fields.body ?? "1. Open the game\n2. It crashes");
  fd.set("severity", fields.severity ?? "high");
  fd.set("platform", "Windows");
  for (const [name, bytes, type] of files) fd.append("screenshot", new File([bytes], name, { type }));
  return call("/t/alpha/bugs", { method: "POST", headers: { Origin: ORIGIN, Cookie: t.cookie }, body: fd });
}

describe("feedback", () => {
  let t;
  beforeEach(async () => {
    await resetAll({ KEYS: fakeKeys().binding });
    const calls = await synced();
    t = await activeTester("alpha", "ada@example.com", calls);
  });

  it("sniffs screenshots by their first bytes", () => {
    expect(sniffImage(png(20))).toBe("image/png");
    expect(sniffImage(jpeg(20))).toBe("image/jpeg");
    expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImage(new TextEncoder().encode("<html><script>alert(1)</script>"))).toBe(null);
    expect(sniffImage(new Uint8Array([0x89, 0x50]))).toBe(null);
  });

  it("one survey response per tester, editable", async () => {
    const r1 = await post("/t/alpha/survey/s1", { csrf: t.csrf, build: "a-gh", fun: "4", notes: "nice" }, t.cookie);
    expect(r1.status).toBe(303);
    setNow(NOW + MIN);
    await post("/t/alpha/survey/s1", { csrf: t.csrf, build: "a-gh", fun: "5" }, t.cookie);
    const r = await rows("SELECT answers, submitted_at, updated_at FROM responses");
    expect(r).toHaveLength(1);
    expect(JSON.parse(r[0].answers)).toEqual({ fun: 5 });
    expect(r[0].updated_at - r[0].submitted_at).toBe(MIN);
    expect((await post("/t/alpha/survey/s1", { csrf: t.csrf, build: "a-gh", fun: "9" }, t.cookie)).status).toBe(400);
    expect((await post("/t/alpha/survey/s1", { csrf: t.csrf, build: "a-link", fun: "3" }, t.cookie)).status).toBe(404);
    expect((await post("/t/alpha/survey/s1", { csrf: "bad", build: "a-gh", fun: "3" }, t.cookie)).status).toBe(403);
    const fb = await api("GET", "feedback?survey=s1");
    expect(fb.data.responses[0].answers).toEqual({ fun: 5 });
  });

  it("closes surveys when the beta closes", async () => {
    await api("POST", "betas/alpha/close");
    expect((await post("/t/alpha/survey/s1", { csrf: t.csrf, build: "a-gh", fun: "4" }, t.cookie)).status).toBe(403);
  });

  it("stores a bug with two 400 KB screenshots", async () => {
    const res = await bug(t, [["a.png", png(400 * KB), "image/png"], ["b.jpg", jpeg(400 * KB), "image/jpeg"]]);
    expect(res.status).toBe(200);
    const b = await rows("SELECT id, title, severity, images, images_note FROM bugs");
    expect(b[0]).toMatchObject({ title: "Crash on load", severity: "high", images: 2, images_note: null });
    const imgs = await rows("SELECT n, mime, size FROM bug_images ORDER BY n");
    expect(imgs).toEqual([{ n: 1, mime: "image/png", size: 400 * KB }, { n: 2, mime: "image/jpeg", size: 400 * KB }]);
    const img = await api("GET", `bugs/${b[0].id}/images/2`);
    expect(img.res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(img.res.headers.get("Content-Disposition")).toMatch(/^attachment; filename=/);
    expect(img.res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(img.res.headers.get("Content-Security-Policy")).toContain("sandbox");
  });

  it("refuses a third image, a 500 KB image and an HTML file renamed .png, with a clear message", async () => {
    const three = await bug(t, [["a.png", png(1000), "image/png"], ["b.png", png(1000), "image/png"], ["c.png", png(1000), "image/png"]]);
    expect(three.status).toBe(400);
    expect(await three.text()).toContain("At most 2 screenshots");
    const big = await bug(t, [["a.png", png(500 * KB), "image/png"]]);
    expect(big.status).toBe(400);
    expect(await big.text()).toContain("at most 400 KB");
    const fake = await bug(t, [["evil.png", new TextEncoder().encode("<html><script>alert(1)</script></html>"), "image/png"]]);
    expect(fake.status).toBe(400);
    expect(await fake.text()).toContain("must be PNG, JPEG or WebP");
    expect(await rows("SELECT id FROM bugs")).toHaveLength(0);
  });

  it("over the total cap, stores the bug without images and says so", async () => {
    // totalCap is 1 MB in the test config: 800 KB fits, the next 400 KB doesn't.
    await bug(t, [["a.png", png(400 * KB), "image/png"], ["b.png", png(400 * KB), "image/png"]]);
    const res = await bug(t, [["c.png", png(300 * KB), "image/png"]]);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("saved without its screenshots");
    const b = await rows("SELECT images, images_note FROM bugs ORDER BY created_at, images");
    expect(b.find((x) => x.images === 0).images_note).toContain("storage is full");
    expect(await rows("SELECT bug_id FROM bug_images")).toHaveLength(2);
  });

  it("refuses a multipart body over 900 KB before reading it, and validates fields", async () => {
    const res = await call("/t/alpha/bugs", { method: "POST", headers: { Origin: ORIGIN, Cookie: t.cookie, "Content-Type": "multipart/form-data; boundary=x", "Content-Length": String(901 * KB) }, body: "x" });
    expect(res.status).toBe(413);
    expect((await bug(t, [], { title: "t".repeat(201) })).status).toBe(400);
    expect((await bug(t, [], { body: "b".repeat(11 * KB) })).status).toBe(400);
    expect((await bug(t, [], { severity: "apocalyptic" })).status).toBe(400);
  });

  it("limits bugs to 20 a day per tester", async () => {
    for (let i = 0; i < 20; i++) expect((await bug(t)).status).toBe(200);
    expect((await bug(t)).status).toBe(429);
  });

  it("the app's status action is applied by Clock", async () => {
    await bug(t);
    const { env } = await import("cloudflare:test");
    await env.DB.prepare("UPDATE bugs SET action_requested = 'triaged'").run();
    const { runClock } = await import("./helpers.js");
    await runClock(NOW + MIN);
    expect((await rows("SELECT status, action_requested FROM bugs"))[0]).toEqual({ status: "triaged", action_requested: null });
  });
});
