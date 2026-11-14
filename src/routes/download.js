// GET /d/:build?t=<tester>&exp=<ms>&sig=<HMAC(LINK_SECRET, build.tester.exp)>
// (docs/SDD.md, "Downloads"). Checks, in order: signature (crypto.subtle.verify,
// constant time), expiry (15 minutes), tester status and terms, the build's
// availability and groups, then the daily limit. Every failure is one 403
// page. Every attempt for a real tester is logged (no IP).
import { sign, verify } from "../lib/crypto.js";
import { downloadsStopped } from "../lib/betas.js";
import { downloadDenied, message } from "../lib/pages.js";
import { d1Hits, memoryHit, ipHash, DAY } from "../lib/rate.js";
import { randomId } from "../lib/crypto.js";
import { resolveAsset, fetchAsset } from "../lib/github.js";

export const LINK_MS = 15 * 60_000;

/** A tester's signed download URL (path + query). */
export async function signedDownload(app, buildId, testerId) {
  const exp = app.now + LINK_MS;
  const sig = await sign(app.env.LINK_SECRET || "", `dl/${buildId}.${testerId}.${exp}`);
  return `/d/${encodeURIComponent(buildId)}?t=${testerId}&exp=${exp}&sig=${sig}`;
}

export function inGroups(build, tester) {
  if (!build.groups) return true;
  const mine = new Set(String(tester.groups ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  return String(build.groups).split(",").some((g) => mine.has(g.trim()));
}

export function buildAvailable(build, now) {
  return build.available_at <= now && (build.expires_at === null || build.expires_at > now);
}

function attachmentName(s) {
  return String(s).split("/").pop().replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "download";
}

export async function handleDownload(request, app, buildId, url) {
  const testerId = url.searchParams.get("t") ?? "";
  const expRaw = url.searchParams.get("exp") ?? "";
  const sig = url.searchParams.get("sig") ?? "";
  if (!/^t_[a-z0-9]{16}$/.test(testerId) || !/^\d{13}$/.test(expRaw) || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(buildId)) return downloadDenied();
  // Cheap flood guard before any D1 read.
  if (!memoryHit(`dl:${await ipHash(app, request)}`, 60, app.now)) return downloadDenied();
  const now = app.now;
  const exp = Number(expRaw);
  const [tRes, bRes] = await app.db.batch([
    app.db.prepare("SELECT t.id, t.beta_id, t.status, t.groups, t.terms_accepted_version, b.closed_at FROM testers t LEFT JOIN betas b ON b.id = t.beta_id WHERE t.id = ?").bind(testerId),
    app.db.prepare("SELECT id, beta_id, source, target, asset_id, groups, available_at, expires_at, config_error FROM builds WHERE id = ?").bind(buildId),
  ]);
  const tester = tRes.results[0];
  const build = bRes.results[0];
  if (!tester) return downloadDenied();
  const log = (result, source = build?.source ?? null) =>
    app.db
      .prepare("INSERT INTO downloads (id, tester_id, build_id, at, source, result, colo) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(randomId("dl"), tester.id, buildId, now, source, result, request.cf?.colo ?? null);
  const refuse = async (result) => {
    try {
      await log(result).run();
    } catch {
      // D1 out of writes: the refusal still stands.
    }
    return downloadDenied();
  };

  const sigOk = await verify(app.env.LINK_SECRET || "", `dl/${buildId}.${testerId}.${exp}`, sig);
  if (!sigOk || exp <= now || exp > now + LINK_MS + 60_000) return refuse("refused_invalid");
  if (tester.status !== "active") return refuse("refused_revoked");
  const beta = app.cfg.byId.get(tester.beta_id);
  if (!beta) return refuse("refused_unavailable");
  if (tester.terms_accepted_version !== beta.terms.version) return refuse("refused_terms");
  if (!build || build.config_error || build.beta_id !== tester.beta_id || !buildAvailable(build, now) || !inGroups(build, tester) || downloadsStopped(beta, tester.closed_at, now))
    return refuse("refused_unavailable");
  let within = true;
  try {
    within = await d1Hits(app, [{ bucket: `dl:${tester.id}`, windowMs: DAY, limit: beta.downloadsPerDay }]);
  } catch {
    // D1 can't count: allow (the edge-case rule: downloads keep working without the log)
  }
  if (!within) return refuse("refused_limit");

  const logged = async (result) => {
    try {
      await log(result).run();
    } catch {
      console.error("download: log write skipped (D1 refused)");
    }
  };

  if (build.source === "link") {
    await logged("started");
    return new Response(null, { status: 302, headers: { Location: build.target, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
  }

  if (build.source === "github") {
    let assetId = build.asset_id;
    if (!assetId) {
      const r = await resolveAsset(app.env, build.target);
      if (r.error) return upstream(app, build, log, r.error);
      assetId = r.id;
      app.waitUntil(app.db.prepare("UPDATE builds SET asset_id = ? WHERE id = ?").bind(assetId, build.id).run().catch(() => {}));
    }
    const r = await fetchAsset(app.env, build.target, assetId);
    if (r.error) {
      if (r.gone) app.waitUntil(app.db.prepare("UPDATE builds SET asset_id = NULL WHERE id = ?").bind(build.id).run().catch(() => {}));
      return upstream(app, build, log, r.error);
    }
    await logged("started");
    if (r.redirect) return new Response(null, { status: 302, headers: { Location: r.redirect, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
    return new Response(r.stream.body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${attachmentName(build.target)}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        ...(r.stream.headers.get("Content-Length") ? { "Content-Length": r.stream.headers.get("Content-Length") } : {}),
      },
    });
  }

  // r2
  if (!app.env.FILES) return upstream(app, build, log, "the FILES R2 binding is missing");
  const obj = await app.env.FILES.get(build.target, { range: request.headers });
  if (!obj) return upstream(app, build, log, "R2 object not found");
  await logged("started");
  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${attachmentName(build.target)}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes",
  };
  const rg = obj.range;
  if (rg && request.headers.has("Range")) {
    const offset = rg.offset ?? (rg.suffix !== undefined ? obj.size - rg.suffix : 0);
    const length = rg.length ?? (rg.suffix !== undefined ? rg.suffix : obj.size - offset);
    headers["Content-Range"] = `bytes ${offset}-${offset + length - 1}/${obj.size}`;
    headers["Content-Length"] = String(length);
    return new Response(obj.body, { status: 206, headers });
  }
  headers["Content-Length"] = String(obj.size);
  return new Response(obj.body, { status: 200, headers });
}

/** GitHub token expired, asset deleted, R2 object missing: logged, and one owner notice a day per build. */
async function upstream(app, build, log, error) {
  const detail = JSON.stringify({ build: build.id, day: new Date(app.now).toISOString().slice(0, 10) });
  console.error(`download ${build.id}: ${String(error).slice(0, 200)}`);
  try {
    await app.db.batch([
      log("upstream_error"),
      app.db
        .prepare("INSERT INTO events (id, tester_id, beta_id, kind, at, detail) SELECT ?, NULL, ?, 'upstream_error', ?, ? WHERE NOT EXISTS (SELECT 1 FROM events WHERE kind = 'upstream_error' AND detail = ?)")
        .bind(randomId("e"), build.beta_id, app.now, detail, detail),
    ]);
  } catch {
    // logging is best effort here
  }
  return message("Temporarily unavailable", "This build is temporarily unavailable. Please try again later.", 503);
}
