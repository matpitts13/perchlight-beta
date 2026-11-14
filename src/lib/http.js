// Small HTTP helpers. From perchlight-hooks src/lib/http.js, plus HTML pages
// with the security headers every page gets (docs/SDD.md, "Security": CSP with
// no inline script except by hash, X-Frame-Options DENY, Referrer-Policy
// no-referrer so a token in a URL never leaks through Referer).

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...extraHeaders },
  });
}

/** An API error: { ok: false, error }. */
export function fail(status, error, extra = {}) {
  return json({ ok: false, error, ...extra }, status);
}

export function text(body, status = 200, extraHeaders = {}) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extraHeaders } });
}

/** @param {unknown} s */
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** Page headers. scriptHashes: CSP hashes of the inline scripts the page carries. */
export function pageHeaders({ scriptHashes = [], turnstile = false } = {}) {
  const scripts = [...(turnstile ? [TURNSTILE_ORIGIN] : []), ...scriptHashes.map((h) => `'${h}'`)];
  const csp = [
    "default-src 'none'",
    `script-src ${scripts.length ? scripts.join(" ") : "'none'"}`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `frame-src ${turnstile ? TURNSTILE_ORIGIN : "'none'"}`,
    `connect-src ${turnstile ? `'self' ${TURNSTILE_ORIGIN}` : "'self'"}`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": csp,
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

export function htmlResponse(body, status = 200, opts = {}, extraHeaders = {}) {
  return new Response(body, { status, headers: { ...pageHeaders(opts), ...extraHeaders } });
}

/** Reads a JSON object of at most maxBytes, or null. */
export async function readJson(request, maxBytes = 32 * 1024) {
  const r = await readBody(request, maxBytes);
  if (!r || r.over) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(r.bytes) || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** The body, refused before reading when Content-Length says it's too big. null = too big. */
export async function readBody(request, maxBytes) {
  const len = Number(request.headers.get("Content-Length") ?? "0");
  if (!(len >= 0) || len > maxBytes) return null;
  const r = await readCapped(request.body, maxBytes);
  return r.over ? null : r;
}

/** Parses a form (urlencoded or multipart) of at most maxBytes; null if too big or not a form. */
export async function readForm(request, maxBytes) {
  const ct = request.headers.get("Content-Type") ?? "";
  const r = await readBody(request, maxBytes);
  if (!r) return { tooBig: true };
  try {
    if (/^application\/json/i.test(ct)) {
      const v = JSON.parse(new TextDecoder().decode(r.bytes) || "{}");
      if (!v || typeof v !== "object" || Array.isArray(v)) return { bad: true };
      const fd = new FormData();
      for (const [k, val] of Object.entries(v)) {
        if (Array.isArray(val)) for (const x of val) fd.append(k, String(x));
        else if (val !== null && val !== undefined) fd.append(k, String(val));
      }
      return { form: fd, json: true };
    }
    if (!/^(application\/x-www-form-urlencoded|multipart\/form-data)/i.test(ct)) return { bad: true };
    return { form: await new Response(r.bytes, { headers: { "Content-Type": ct } }).formData() };
  } catch {
    return { bad: true };
  }
}

/**
 * Reads a stream up to `max` bytes. Stops (and cancels) beyond it.
 * @returns {Promise<{ bytes: Uint8Array, size: number, over: boolean }>}
 */
export async function readCapped(stream, max) {
  if (!stream) return { bytes: new Uint8Array(0), size: 0, over: false };
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  let over = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      over = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return { bytes: all, size, over };
}

export function utcDay(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function utcMonth(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 7);
}

/** The next UTC day after `day` (YYYY-MM-DD). */
export function nextDay(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export function isoTime(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

export const parseJson = (s, d) => {
  try {
    return s == null ? d : JSON.parse(s);
  } catch {
    return d;
  }
};

export function redirect(location, status = 303, extra = {}) {
  return new Response(null, { status, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...extra } });
}
