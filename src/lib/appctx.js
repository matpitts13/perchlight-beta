// What the routes and Clock take: env, the checked config, the public base URL
// and host, now(). As perchlight-hooks src/lib/appctx.js.
import { checkConfig } from "./config.js";
import { sha256Hex } from "./crypto.js";

// beta.json is checked once per isolate (per public host).
const checked = new WeakMap();
export function configFor(raw, terms, ownHost) {
  let m = checked.get(raw);
  if (!m) {
    m = new Map();
    checked.set(raw, m);
  }
  let c = m.get(ownHost);
  if (!c) {
    c = checkConfig(raw, { terms, ownHost });
    m.set(ownHost, c);
  }
  return c;
}

/** The time source (tests replace clock.now). */
export const clock = { now: () => Date.now() };

/** Tests only: bindings merged over env (a fake send_email, KEYS, a broken D1). */
export const testHooks = { env: null };

export function makeApp(raw, terms, env, { origin, now, ctx } = {}) {
  const e = testHooks.env ? { ...env, ...testHooks.env } : env;
  const base = (String(e.PUBLIC_URL ?? "").trim() || origin || "https://beta.invalid").replace(/\/+$/, "");
  let host = "beta.invalid";
  try {
    host = new URL(base).hostname;
  } catch {
    // keep the placeholder
  }
  const cfg = configFor(raw, terms, host);
  const t = now ?? (() => clock.now());
  return {
    env: e,
    cfg,
    base,
    host,
    db: e.DB,
    get now() {
      return t();
    },
    waitUntil: (p) => (ctx ? ctx.waitUntil(p) : p),
  };
}

const shaCache = new WeakMap();
/** SHA-256 of a beta's exact terms text (cached per isolate). */
export async function termsSha(beta) {
  let s = shaCache.get(beta);
  if (!s) {
    s = await sha256Hex(beta.terms.text);
    shaCache.set(beta, s);
  }
  return s;
}

/** The one Clock instance. */
export function clockStub(env) {
  return env.CLOCK.get(env.CLOCK.idFromName(env.CLOCK_NAME || "clock"));
}
