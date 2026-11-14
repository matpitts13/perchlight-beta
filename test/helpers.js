import { env, createExecutionContext, waitOnExecutionContext, runInDurableObject } from "cloudflare:test";
import { makeWorker, resetWatchdog } from "../src/app.js";
import { clock, testHooks } from "../src/lib/appctx.js";
import { net } from "../src/lib/net.js";
import { resetRate } from "../src/lib/rate.js";
import { TEST_CONFIG, NOW } from "./config.js";

export { NOW };
export const ORIGIN = "https://beta.test";
export const TOKEN = "test-admin-token-0123456789";
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const worker = makeWorker(TEST_CONFIG);
const realFetch = net.fetch;

export function setNow(ms) {
  clock.now = () => ms;
}

/**
 * Fake network. routes: url prefix -> { status, body, headers } | "down" | (url, init, n) => same | Response.
 * Defaults: Turnstile passes (token "bad" fails), Resend accepts. Every call is recorded.
 */
export function fakeNet(routes = {}) {
  const calls = [];
  const defaults = {
    "https://challenges.cloudflare.com/": (url, init) => ({ status: 200, body: JSON.stringify(init.body?.get?.("response") === "bad" ? { success: false, "error-codes": ["invalid-input-response"] } : { success: true }) }),
    "https://api.resend.com/": () => ({ status: 200, body: JSON.stringify({ id: `re_${crypto.randomUUID()}` }) }),
  };
  const pick = (table, url) => Object.keys(table).filter((k) => url.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  net.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    let body = null;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const headers = new Headers(init.headers ?? {});
    calls.push({ url, method: init.method ?? "GET", headers, body });
    const own = pick(routes, url);
    const def = own === undefined ? pick(defaults, url) : undefined;
    let r = own !== undefined ? routes[own] : def !== undefined ? defaults[def] : undefined;
    if (typeof r === "function") r = await r(url, init, calls.length);
    if (r === undefined) throw new Error(`unexpected fetch in test: ${url}`);
    if (r instanceof Response) return r;
    if (r === "down") throw new TypeError("Network connection lost.");
    return new Response(r.status === 204 || r.status === 304 ? null : (r.body ?? ""), { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  return calls;
}

export function restoreNet() {
  net.fetch = realFetch;
}

/** Resend calls a fake network saw: { to, subject, text, key }. */
export function emails(calls) {
  return calls.filter((c) => c.url === "https://api.resend.com/emails").map((c) => ({ to: c.body.to[0], subject: c.body.subject, text: c.body.text, key: c.headers.get("Idempotency-Key") }));
}

/** A fake send_email binding that records messages. */
export function fakeEmail() {
  const sent = [];
  return { sent, binding: { async send(m) { sent.push(m); } } };
}

/** A fake perchlight-keys service binding. */
export function fakeKeys(handler) {
  const calls = [];
  return {
    calls,
    binding: {
      async fetch(url, init) {
        const body = init?.body ? JSON.parse(init.body) : null;
        calls.push({ url: String(url), auth: new Headers(init?.headers).get("Authorization"), body });
        const r = handler ? await handler(String(url), body, calls.length) : null;
        if (r instanceof Response) return r;
        if (String(url).endsWith("/api/licenses")) return Response.json({ existing: false, license: { id: "lic_abc123" } }, { status: 201 });
        return Response.json({ ok: true });
      },
    },
  };
}

let n = 0;
export async function resetAll(extraEnv = {}) {
  restoreNet();
  resetWatchdog();
  resetRate();
  setNow(NOW);
  testHooks.env = { CLOCK_NAME: `clock-${Date.now()}-${n++}`, ...extraEnv };
  const tables = ["betas", "testers", "invites", "signins", "acceptances", "builds", "downloads", "responses", "bugs", "bug_images", "events", "deliveries", "rate"];
  await env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

export function setEnv(extra) {
  testHooks.env = { ...testHooks.env, ...extra };
}

export function clockStub() {
  return env.CLOCK.get(env.CLOCK.idFromName(testHooks.env.CLOCK_NAME));
}

/** One Clock run at `at` (the Worker's clock is set to it too). */
export async function runClock(at = clock.now()) {
  setNow(at);
  return runInDurableObject(clockStub(), (inst) => inst.run(at));
}

export function inClock(fn) {
  return runInDurableObject(clockStub(), fn);
}

export async function call(path, init = {}) {
  resetWatchdog();
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function api(method, path, body, token = TOKEN) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await call(`/api/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  let data;
  try {
    data = JSON.parse(t);
  } catch {
    data = t;
  }
  return { status: res.status, data, res };
}

export async function rows(sql, ...params) {
  return (await env.DB.prepare(sql).bind(...params).all()).results;
}

export function form(fields) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const x of v) p.append(k, x);
    else if (v !== undefined && v !== null) p.append(k, String(v));
  }
  return p;
}

/** POST a form from this site (Origin set), with an optional cookie. */
export function post(path, fields, cookie, extraHeaders = {}) {
  return call(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
    body: form(fields),
  });
}

export function get(path, cookie) {
  return call(path, { headers: cookie ? { Cookie: cookie } : {} });
}

export async function apply(beta, fields = {}, headers = {}) {
  return call(`/b/${beta}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": headers.ip ?? "203.0.113.9" },
    body: form({ name: "Ada Tester", email: "ada@example.com", platform: ["Windows"], "cf-turnstile-response": "ok", ...fields }),
  });
}

export async function testerId(beta, email) {
  const { emailHmac } = await import("../src/lib/testers.js");
  const h = await emailHmac({ env }, email);
  return (await rows("SELECT id FROM testers WHERE beta_id = ? AND email_hmac = ?", beta, h))[0]?.id ?? null;
}

export function csrfOf(html) {
  return /name="csrf" value="([a-f0-9]{32})"/.exec(html)?.[1] ?? null;
}

export function linkIn(text, kind) {
  const m = new RegExp(`https://beta\\.test/${kind}/([A-Za-z0-9_-]{22})`).exec(text);
  return m ? m[1] : null;
}

export function cookieOf(res) {
  const c = res.headers.get("Set-Cookie") ?? "";
  const m = /^(pb_s=[^;]+)/.exec(c);
  return m ? m[1] : null;
}

/** Synced Clock (config copied into D1). Returns the network calls array. */
export async function synced(routes = {}) {
  const calls = fakeNet(routes);
  await runClock(NOW);
  return calls;
}

/** Apply -> approve -> Clock sends the invite -> returns the token. */
export async function invited(beta, email, calls, name = "Ada Tester") {
  const r = await apply(beta, { email, name, ...(beta === "alpha" ? {} : { platform: undefined }) });
  if (r.status !== 200) throw new Error(`apply ${r.status}`);
  const id = await testerId(beta, email);
  const d = await api("POST", "applications/decide", { ids: [id], action: "approve" });
  if (d.status !== 200) throw new Error(`decide ${d.status} ${JSON.stringify(d.data)}`);
  const before = emails(calls).length;
  await runClock(clock.now());
  const sent = emails(calls).slice(before).filter((m) => m.to === email && /invited/.test(m.subject));
  return { id, token: linkIn(sent.at(-1)?.text ?? "", "i") };
}

/** Claims an invite (GET for the CSRF value, then POST). Returns the response and cookie. */
export async function claim(token, { name = "Ada Lovelace", version, accept = "1", cookie } = {}) {
  const page = await get(`/i/${token}`);
  const html = await page.text();
  const csrf = csrfOf(html);
  const v = version ?? /name="version" value="([^"]+)"/.exec(html)?.[1];
  const res = await post(`/i/${token}/claim`, { csrf, version: v, full_name: name, accept }, cookie);
  return { res, cookie: cookieOf(res), csrf };
}

/** A signed-in active tester. */
export async function activeTester(beta, email, calls) {
  const { id, token } = await invited(beta, email, calls);
  const { cookie } = await claim(token);
  if (!cookie) throw new Error("claim failed");
  const page = await get(`/t/${beta}`, cookie);
  const html = await page.text();
  return { id, cookie, csrf: csrfOf(html), html };
}
