// perchlight-keys client (docs/SDD.md, "perchlight-keys"), called only by
// Clock from key_issue / key_revoke deliveries, one call per run.
//
// Interface, coded against perchlight-keys' documented admin API:
//   POST {KEYS}/api/licenses  {product, edition, email, source: "import",
//        source_ref: "beta:<beta>:<tester id>", expires_days, send_email: true,
//        notes: "perchlight-beta"}  -> 201 {existing:false, license:{id}} or
//        200 {existing:true, license:{id}} (UNIQUE (source, source_ref)).
//   POST {KEYS}/api/licenses/<id>/revoke  {reason: "beta access revoked"}
//
// Transport (decision 3): a KEYS service binding is required. perchlight-keys
// has only a full ADMIN_TOKEN today; a scoped ISSUE_TOKEN (issue and revoke
// only, source "import", source_ref "beta:…") is a planned follow-up there.
// KEYS_URL (SSRF-checked, redirects not followed) is used only once you set
// KEYS_TOKEN_SCOPED=1 to say KEYS_TOKEN is that scoped token. Not tested
// against a real perchlight-keys (TECH_DEBT.md).
import { checkTarget } from "./ssrf.js";
import { net } from "./net.js";

/** How keys calls go out, or { error } (the config check shows it; deliveries wait). */
export function keysTransport(env) {
  if (!env.KEYS_TOKEN) return { error: "KEYS_TOKEN isn't set" };
  if (env.KEYS && typeof env.KEYS.fetch === "function") return { kind: "binding", base: "https://perchlight-keys.internal", fetch: (u, i) => env.KEYS.fetch(u, i) };
  if (env.KEYS_URL) {
    if (String(env.KEYS_TOKEN_SCOPED ?? "") !== "1")
      return { error: "a KEYS service binding is required until perchlight-keys has a scoped ISSUE_TOKEN (set KEYS_TOKEN_SCOPED=1 only with that token)" };
    const r = checkTarget(env.KEYS_URL);
    if (!r.ok) return { error: `KEYS_URL ${r.error}` };
    return { kind: "url", base: r.url.origin + r.url.pathname.replace(/\/+$/, ""), fetch: (u, i) => net.fetch(u, i) };
  }
  return { error: "no KEYS service binding" };
}

async function call(env, path, body) {
  const t = keysTransport(env);
  if (t.error) return { status: "config", error: t.error };
  try {
    const res = await t.fetch(`${t.base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.KEYS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // not JSON
    }
    if (res.status >= 200 && res.status < 300) return { status: "ok", data };
    if (res.status === 401 || res.status === 403) return { status: "config", error: `perchlight-keys ${res.status}` };
    if (res.status === 404) return { status: "not_found", error: "perchlight-keys 404" };
    if (res.status >= 400 && res.status < 500 && res.status !== 429) return { status: "rejected", error: `perchlight-keys ${res.status}: ${String(data?.error ?? text).slice(0, 200)}` };
    return { status: "retry", error: `perchlight-keys ${res.status}` };
  } catch (err) {
    return { status: "retry", error: `perchlight-keys unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Issues (or finds) the tester's beta key. Returns { status: "ok", licenseId } or a failure. */
export async function issueKey(env, { beta, tester }) {
  const r = await call(env, "/api/licenses", {
    product: beta.keys.product,
    ...(beta.keys.edition ? { edition: beta.keys.edition } : {}),
    email: tester.email,
    ...(tester.name ? { name: tester.name } : {}),
    source: "import",
    source_ref: `beta:${beta.id}:${tester.id}`,
    expires_days: beta.keys.expiresDays,
    send_email: true,
    notes: "perchlight-beta",
  });
  if (r.status !== "ok") return r;
  const id = r.data?.license?.id;
  if (typeof id !== "string" || !/^lic_[a-z0-9]{1,40}$/.test(id)) return { status: "retry", error: "perchlight-keys answered without a licence id" };
  return { status: "ok", licenseId: id };
}

export async function revokeKey(env, licenseId) {
  if (!/^lic_[a-z0-9]{1,40}$/.test(String(licenseId))) return { status: "rejected", error: "bad licence id" };
  const r = await call(env, `/api/licenses/${licenseId}/revoke`, { reason: "beta access revoked" });
  if (r.status === "not_found") return { status: "ok" }; // nothing left to revoke
  return r;
}
