// beta.json, checked once per isolate (docs/SDD.md, "Config"). A beta or build
// with a mistake is switched off with the reason (GET /api/betas); the others
// keep working. At most 10 betas per deployment.
import { checkTarget } from "./ssrf.js";

export const MAX_BETAS = 10;
export const MAX_QUESTIONS = 20;
export const MAX_BUILDS = 100;
export const QUESTION_TYPES = ["text", "longtext", "choice", "multi", "checkbox", "number"];
export const SURVEY_TYPES = [...QUESTION_TYPES, "rating"];
export const BETA_TYPES = ["game", "app", "book"];
export const BETA_STATUSES = ["draft", "open", "closed"];
export const SOURCES = ["link", "github", "r2"];
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const DAY = 86_400_000;

const DEFAULT_REMINDERS = { unclaimedInvite: 5, newBuild: true, surveyNudge: 3, endingSoon: 3 };
const DEFAULT_RETENTION = { declinedDays: 30, afterCloseDays: 180, acceptanceDays: 730 };

/** "400KB" / "150MB" / 1234 -> bytes, or null. */
export function parseSize(v) {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?\s*$/i.exec(String(v ?? ""));
  if (!m) return null;
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[(m[2] ?? "B").toUpperCase()];
  return Math.round(Number(m[1]) * mult);
}

function int(v, def, min, max) {
  if (v === undefined || v === null) return def;
  return Number.isInteger(v) && v >= min && v <= max ? v : NaN;
}

/** Days for a reminder: a number of days, true (= default), false/0 (= off). */
function reminderDays(v, def) {
  if (v === undefined) return def;
  if (v === false || v === 0) return 0;
  if (v === true) return def;
  return Number.isInteger(v) && v >= 1 && v <= 60 ? v : NaN;
}

function parseTime(v) {
  if (v === undefined || v === null || v === "") return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? `${v}T23:59:59Z` : String(v));
  return Number.isFinite(t) ? t : NaN;
}

/** Checks one question list; returns [questions, error]. */
export function checkQuestions(list, types = QUESTION_TYPES) {
  if (list === undefined) return [[], null];
  if (!Array.isArray(list)) return [null, "questions must be a list"];
  if (list.length > MAX_QUESTIONS) return [null, `at most ${MAX_QUESTIONS} questions`];
  const out = [];
  const seen = new Set();
  for (const q of list) {
    if (!q || typeof q !== "object") return [null, "each question must be an object"];
    if (typeof q.id !== "string" || !ID.test(q.id) || ["name", "email", "src", "csrf", "website", "cf-turnstile-response"].includes(q.id)) return [null, `question id "${q.id}" isn't allowed (a-z, 0-9, _ and -)`];
    if (seen.has(q.id)) return [null, `question id "${q.id}" is used twice`];
    seen.add(q.id);
    if (!types.includes(q.type)) return [null, `question "${q.id}": type must be one of ${types.join(", ")}`];
    if (typeof q.label !== "string" || !q.label.trim() || q.label.length > 300) return [null, `question "${q.id}": label (1-300 characters) is required`];
    const c = { id: q.id, type: q.type, label: q.label, required: q.required === true };
    if (q.type === "choice" || q.type === "multi") {
      if (!Array.isArray(q.options) || q.options.length < 1 || q.options.length > 30 || q.options.some((o) => typeof o !== "string" || !o || o.length > 100))
        return [null, `question "${q.id}": options must be 1-30 strings of up to 100 characters`];
      c.options = [...q.options];
    }
    if (q.type === "text" || q.type === "longtext") {
      const cap = q.type === "text" ? 200 : 2000;
      const max = q.max === undefined ? cap : q.max;
      if (!Number.isInteger(max) || max < 1 || max > cap) return [null, `question "${q.id}": max must be 1-${cap}`];
      c.max = max;
    }
    if (q.type === "number") {
      c.min = Number.isFinite(q.min) ? q.min : -1e12;
      c.max = Number.isFinite(q.max) ? q.max : 1e12;
    }
    out.push(c);
  }
  return [out, null];
}

/**
 * Validates submitted answers against a question list.
 * @param {(name: string) => string[]} getAll  values of a form field
 * @returns {{ answers: Record<string, unknown>, errors: string[] }}
 */
export function validateAnswers(questions, getAll) {
  const answers = {};
  const errors = [];
  for (const q of questions) {
    const vals = getAll(q.id).map((v) => (typeof v === "string" ? v : "")).filter((v) => v !== "");
    const missing = vals.length === 0;
    if (missing) {
      if (q.required) errors.push(`"${q.label}" is required.`);
      continue;
    }
    if (vals.length > 1 && q.type !== "multi") {
      errors.push(`"${q.label}": one answer only.`);
      continue;
    }
    const v = vals[0];
    switch (q.type) {
      case "text":
      case "longtext":
        if (v.length > q.max) errors.push(`"${q.label}": at most ${q.max} characters.`);
        else answers[q.id] = v;
        break;
      case "choice":
        if (!q.options.includes(v)) errors.push(`"${q.label}": not one of the options.`);
        else answers[q.id] = v;
        break;
      case "multi": {
        const uniq = [...new Set(vals)];
        if (uniq.some((x) => !q.options.includes(x))) errors.push(`"${q.label}": not one of the options.`);
        else answers[q.id] = uniq;
        break;
      }
      case "checkbox":
        answers[q.id] = true;
        break;
      case "number": {
        const n = Number(v);
        if (v.length > 30 || !Number.isFinite(n) || n < q.min || n > q.max) errors.push(`"${q.label}": a number from ${q.min} to ${q.max}.`);
        else answers[q.id] = n;
        break;
      }
      case "rating": {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 5) errors.push(`"${q.label}": 1 to 5.`);
        else answers[q.id] = n;
        break;
      }
    }
  }
  return { answers, errors };
}

/** A `link` build URL: a redirect target only, checked with hooks' rules plus "not this deployment". */
export function checkLinkUrl(raw, ownHost) {
  const r = checkTarget(raw);
  if (!r.ok) return r;
  const host = r.url.hostname.toLowerCase().replace(/\.+$/, "");
  if (ownHost && host === String(ownHost).toLowerCase()) return { ok: false, error: "points at this deployment's own host" };
  return r;
}

function checkBeta(id, b, terms) {
  if (!b || typeof b !== "object") return { error: "must be an object" };
  const name = typeof b.name === "string" && b.name.trim() && b.name.length <= 100 ? b.name.trim() : null;
  if (!name) return { error: "name (1-100 characters) is required" };
  const type = b.type ?? "game";
  if (!BETA_TYPES.includes(type)) return { error: `type must be one of ${BETA_TYPES.join(", ")}` };
  const status = b.status ?? "draft";
  if (!BETA_STATUSES.includes(status)) return { error: `status must be one of ${BETA_STATUSES.join(", ")}` };
  const maxTesters = int(b.maxTesters, 500, 1, 100000);
  if (Number.isNaN(maxTesters)) return { error: "maxTesters must be 1-100000" };
  const endsAt = parseTime(b.endsAt);
  if (Number.isNaN(endsAt)) return { error: "endsAt must be a date (YYYY-MM-DD) or an ISO time" };
  const sources = b.sources ?? [];
  if (!Array.isArray(sources) || sources.length > 20 || sources.some((s) => typeof s !== "string" || !ID.test(s))) return { error: "sources must be up to 20 ids (a-z, 0-9, _ and -)" };
  const [questions, qErr] = checkQuestions(b.questions);
  if (qErr) return { error: qErr };
  const t = b.terms;
  if (!t || typeof t !== "object" || typeof t.version !== "string" || !t.version || t.version.length > 40) return { error: "terms.version (1-40 characters) is required" };
  let text = typeof t.text === "string" ? t.text : null;
  if (text === null && typeof t.file === "string") text = Object.hasOwn(terms, t.file) ? terms[t.file] : null;
  if (typeof text !== "string" || !text.trim()) return { error: `terms text not found (${t.file ?? "no file or text"}); list the file in src/terms.js` };
  if (text.length > 100_000) return { error: "terms text is over 100,000 characters" };
  let keys = null;
  if (b.keys !== undefined) {
    const k = b.keys;
    if (!k || typeof k.product !== "string" || !k.product || (k.edition !== undefined && typeof k.edition !== "string")) return { error: "keys needs product (and optionally edition, expiresDays)" };
    const expiresDays = int(k.expiresDays, 90, 1, 36500);
    if (Number.isNaN(expiresDays)) return { error: "keys.expiresDays must be 1-36500" };
    keys = { product: k.product, edition: k.edition ?? null, expiresDays };
  }
  const r = { ...DEFAULT_REMINDERS, ...(b.reminders ?? {}) };
  const reminders = {
    unclaimedInvite: reminderDays(r.unclaimedInvite, 5),
    newBuild: r.newBuild !== false,
    surveyNudge: reminderDays(r.surveyNudge, 3),
    endingSoon: reminderDays(r.endingSoon, 3),
  };
  if (Object.values(reminders).some((v) => Number.isNaN(v))) return { error: "reminders: days must be 1-60, or false" };
  const ret = { ...DEFAULT_RETENTION, ...(b.retention ?? {}) };
  const retention = {
    declinedDays: int(ret.declinedDays, 30, 0, 3650),
    afterCloseDays: int(ret.afterCloseDays, 180, 0, 3650),
    acceptanceDays: int(ret.acceptanceDays, 730, 0, 3650),
  };
  if (Object.values(retention).some((v) => Number.isNaN(v))) return { error: "retention: days must be 0-3650" };
  const inviteDays = int(b.inviteDays, 14, 1, 60);
  if (Number.isNaN(inviteDays)) return { error: "inviteDays must be 1-60" };
  const downloadsPerDay = int(b.downloadsPerDay, 30, 1, 1000);
  if (Number.isNaN(downloadsPerDay)) return { error: "downloadsPerDay must be 1-1000" };
  const closeGraceDays = int(b.closeGraceDays, 7, 0, 365);
  if (Number.isNaN(closeGraceDays)) return { error: "closeGraceDays must be 0-365" };
  return {
    id,
    name,
    type,
    status,
    maxTesters,
    endsAt,
    sources,
    questions,
    terms: { version: t.version, text },
    keys,
    reminders,
    retention,
    inviteDays,
    downloadsPerDay,
    closeGraceDays,
    keepBugs: b.keepBugs === true,
    error: null,
  };
}

/** A build (from beta.json or POST /api/builds). Returns { build } or { error }. */
export function checkBuild(id, b, { betaIds, surveys, ownHost }) {
  if (typeof id !== "string" || !ID.test(id)) return { error: "id must be a-z, 0-9, _ and - (up to 40)" };
  if (!b || typeof b !== "object") return { error: "must be an object" };
  if (typeof b.beta !== "string" || !betaIds.has(b.beta)) return { error: `beta "${b.beta}" isn't defined` };
  if (typeof b.label !== "string" || !b.label.trim() || b.label.length > 100) return { error: "label (1-100 characters) is required" };
  const source = b.source ?? "link";
  if (!SOURCES.includes(source)) return { error: `source must be one of ${SOURCES.join(", ")}` };
  let target;
  if (source === "link") {
    const r = checkLinkUrl(b.url, ownHost);
    if (!r.ok) return { error: `url ${r.error}` };
    target = r.url.href;
  } else if (source === "github") {
    if (typeof b.repo !== "string" || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(b.repo)) return { error: "repo must be owner/name" };
    if (typeof b.tag !== "string" || !b.tag || b.tag.length > 200 || /[\s?#]/.test(b.tag)) return { error: "tag is required" };
    if (typeof b.asset !== "string" || !b.asset || b.asset.length > 255) return { error: "asset (the file name) is required" };
    target = `${b.repo}/${b.tag}/${b.asset}`;
  } else {
    if (typeof b.key !== "string" || !b.key || b.key.length > 1024 || b.key.startsWith("bugs/")) return { error: "key (the R2 object key, not under bugs/) is required" };
    target = b.key;
  }
  const groups = b.groups ?? null;
  if (groups !== null && (!Array.isArray(groups) || groups.length > 20 || groups.some((g) => typeof g !== "string" || !ID.test(g)))) return { error: "groups must be up to 20 ids" };
  const survey = b.survey ?? null;
  if (survey !== null && (typeof survey !== "string" || !Object.hasOwn(surveys, survey))) return { error: `survey "${survey}" isn't defined` };
  const availableAt = parseTime(b.availableAt);
  const expiresAt = parseTime(b.expiresAt);
  if (Number.isNaN(availableAt) || Number.isNaN(expiresAt)) return { error: "availableAt and expiresAt must be dates" };
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
  return {
    build: {
      id,
      beta: b.beta,
      label: b.label.trim(),
      platform: str(b.platform, 50),
      notes: str(b.notes, 2000),
      source,
      target,
      groups,
      survey,
      availableAt,
      expiresAt,
      mark: str(b.mark, 200),
    },
  };
}

/**
 * Checks the whole config. Never throws: problems are reported per item.
 * @param {any} raw  beta.json
 * @param {{ terms?: Record<string, string>, ownHost?: string | null }} opts
 */
export function checkConfig(raw, { terms = {}, ownHost = null } = {}) {
  const errors = [];
  const betas = [];
  const rawBetas = raw?.betas && typeof raw.betas === "object" ? Object.entries(raw.betas) : [];
  if (rawBetas.length > MAX_BETAS) errors.push(`at most ${MAX_BETAS} betas per deployment; the rest are switched off`);
  rawBetas.forEach(([id, b], i) => {
    if (!ID.test(id)) {
      betas.push({ id, error: "id must be a-z, 0-9, _ and - (up to 40)" });
      return;
    }
    if (i >= MAX_BETAS) {
      betas.push({ id, name: b?.name ?? id, error: `over the ${MAX_BETAS}-beta limit` });
      return;
    }
    const c = checkBeta(id, b, terms);
    betas.push(c.error ? { id, name: typeof b?.name === "string" ? b.name : id, error: c.error } : c);
  });
  const byId = new Map(betas.filter((b) => !b.error).map((b) => [b.id, b]));

  const surveys = {};
  const surveyErrors = {};
  for (const [id, s] of Object.entries(raw?.surveys ?? {})) {
    if (!ID.test(id)) {
      surveyErrors[id] = "bad id";
      continue;
    }
    const [questions, err] = checkQuestions(s?.questions, SURVEY_TYPES);
    if (err || !questions.length) surveyErrors[id] = err ?? "a survey needs at least one question";
    else surveys[id] = { id, questions };
  }

  const builds = [];
  const rawBuilds = Object.entries(raw?.builds ?? {});
  if (rawBuilds.length > MAX_BUILDS) errors.push(`at most ${MAX_BUILDS} builds in beta.json; the rest are switched off (add more with POST /api/builds)`);
  for (const [i, [id, b]] of rawBuilds.entries()) {
    if (i >= MAX_BUILDS) {
      builds.push({ id, beta: null, error: `over the ${MAX_BUILDS}-build limit` });
      continue;
    }
    const r = checkBuild(id, b, { betaIds: new Set(byId.keys()), surveys, ownHost });
    builds.push(r.error ? { id, beta: b?.beta ?? null, error: r.error } : { ...r.build, error: null });
  }

  const em = raw?.email ?? {};
  const dailyCap = int(em.dailyCap, 90, 1, 100000);
  const monthlyCap = int(em.monthlyCap, 2800, 1, 3_000_000);
  let signinReserve = int(em.signinReserve, 10, 0, 1000);
  if (Number.isNaN(dailyCap) || Number.isNaN(monthlyCap) || Number.isNaN(signinReserve)) errors.push("email caps must be positive integers; using 90 / 2800 / 10");
  if (Number.isNaN(signinReserve)) signinReserve = 10;
  if ((Number.isNaN(dailyCap) ? 90 : dailyCap) + signinReserve > 100) errors.push("email.dailyCap + email.signinReserve is above Resend's free 100 a day");
  if (dailyCap > 100 || monthlyCap > 3000) errors.push("email caps are above Resend's free plan (100 a day, 3,000 a month)");
  const sc = raw?.screenshots ?? {};
  const store = sc.store ?? "d1";
  const maxBytes = parseSize(sc.maxBytes ?? "400KB");
  const perBug = int(sc.perBug, 2, 0, 2);
  const totalCap = parseSize(sc.totalCap ?? (store === "r2" ? "1GB" : "150MB"));
  const scBad = !["d1", "r2"].includes(store) || maxBytes === null || maxBytes > 400 * 1024 || Number.isNaN(perBug) || totalCap === null || (store === "d1" && totalCap > 300 * 1024 ** 2);
  if (scBad) errors.push("screenshots: store d1|r2, maxBytes up to 400KB, perBug 0-2, totalCap up to 300MB in D1; using the defaults");

  return {
    betas,
    byId,
    builds,
    buildById: new Map(builds.filter((b) => !b.error).map((b) => [b.id, b])),
    surveys,
    surveyErrors,
    email: { dailyCap: Number.isNaN(dailyCap) ? 90 : dailyCap, monthlyCap: Number.isNaN(monthlyCap) ? 2800 : monthlyCap, signinReserve },
    screenshots: scBad ? { store: "d1", maxBytes: 400 * 1024, perBug: 2, totalCap: 150 * 1024 ** 2 } : { store, maxBytes, perBug, totalCap },
    errors,
  };
}

export { DAY };
