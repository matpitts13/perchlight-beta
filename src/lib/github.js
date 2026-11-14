// Private GitHub release assets (docs/SDD.md, "Downloads"). The host is fixed
// (api.github.com), so there's no SSRF surface. A fine-grained token with
// Contents: read on the builds repository only.
//   resolve: GET /repos/{o}/{r}/releases/tags/{tag} -> the asset id by name,
//            once, cached in builds.asset_id.
//   fetch:   GET /repos/{o}/{r}/releases/assets/{id}, Accept octet-stream,
//            redirect manual: 302 -> GitHub's short-lived URL; 200 -> streamed.
import { net } from "./net.js";

const API = "https://api.github.com";

function headers(env, accept) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "perchlight-beta",
  };
}

export function splitTarget(target) {
  const [owner, repo, ...rest] = String(target).split("/");
  const tag = rest.shift();
  return { owner, repo, tag, asset: rest.join("/") };
}

/** The asset id, or { error }. */
export async function resolveAsset(env, target) {
  if (!env.GITHUB_TOKEN) return { error: "GITHUB_TOKEN isn't set" };
  const t = splitTarget(target);
  try {
    const res = await net.fetch(`${API}/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}/releases/tags/${encodeURIComponent(t.tag)}`, {
      headers: headers(env, "application/vnd.github+json"),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { error: `GitHub ${res.status} for the release` };
    const data = await res.json();
    const a = Array.isArray(data?.assets) ? data.assets.find((x) => x?.name === t.asset) : null;
    return a && Number.isInteger(a.id) ? { id: a.id } : { error: "asset not found in the release" };
  } catch (err) {
    return { error: `GitHub unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** { redirect: url } | { stream: Response } | { error } */
export async function fetchAsset(env, target, assetId) {
  const t = splitTarget(target);
  try {
    const res = await net.fetch(`${API}/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}/releases/assets/${assetId}`, {
      headers: headers(env, "application/octet-stream"),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307) {
      const loc = res.headers.get("Location");
      await res.body?.cancel().catch(() => {});
      if (loc && /^https:\/\//.test(loc)) return { redirect: loc };
      return { error: "GitHub redirect without an https Location" };
    }
    if (res.status === 200) return { stream: res };
    await res.body?.cancel().catch(() => {});
    return { error: `GitHub ${res.status}`, gone: res.status === 404 };
  } catch (err) {
    return { error: `GitHub unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}
