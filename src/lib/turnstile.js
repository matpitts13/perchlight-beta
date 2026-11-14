// Cloudflare Turnstile, checked server-side with siteverify. Copied from
// perchlight-forms src/lib/turnstile.js, through net.fetch so tests can stub
// it. Unlike forms, beta FAILS CLOSED: "unverified" (siteverify unreachable or
// a bad secret) is not stored (docs/SDD.md acceptance: an application without
// a valid Turnstile token is not stored).
import { net } from "./net.js";

const VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** @returns {Promise<{ ok: boolean, reason?: string }>} */
export async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET_KEY) return { ok: false, reason: "not_configured" };
  if (typeof token !== "string" || !token || token.length > 2048) return { ok: false, reason: "missing" };
  try {
    const body = new FormData();
    body.set("secret", env.TURNSTILE_SECRET_KEY);
    body.set("response", token);
    if (ip) body.set("remoteip", ip);
    const res = await net.fetch(VERIFY, { method: "POST", body, signal: AbortSignal.timeout(5000), redirect: "manual" });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const data = await res.json();
    if (data?.success === true) return { ok: true };
    const codes = Array.isArray(data?.["error-codes"]) ? data["error-codes"].map(String) : [];
    if (codes.some((c) => c === "invalid-input-secret" || c === "missing-input-secret")) console.error(`turnstile: setup problem (${codes.join(", ")}); check TURNSTILE_SECRET_KEY`);
    return { ok: false, reason: codes.join(",") || "failed" };
  } catch (err) {
    console.error(`turnstile: unreachable: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, reason: "unreachable" };
  }
}
