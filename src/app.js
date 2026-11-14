// The Worker, built around a beta config (beta.json in production; tests pass
// their own) and the terms texts. It never sends reminders and never empties
// the email queue: Clock does. No cron trigger.
import { makeApp, clockStub } from "./lib/appctx.js";
import { json, text, fail } from "./lib/http.js";
import { message } from "./lib/pages.js";
import { handleApplyPage, handleApply } from "./routes/apply.js";
import { handleInvitePage, handleClaim } from "./routes/invite.js";
import { signinForm, handleSignin, handleSigninPage, handleSigninClaim } from "./routes/signin.js";
import { handleTesterHome, handleTesterPage, handleReaccept, handleSurvey, handleBug, handleReminders, handleExport, handleWithdraw, handleDelete } from "./routes/tester.js";
import { handleDownload } from "./routes/download.js";
import { handleAdmin } from "./routes/admin.js";

export { makeApp };

/** Path plus query, at most 2 KB (docs/SDD.md, "Input limits"). */
export const MAX_URL = 2048;

// The lazy fallback: at most once a minute per isolate, ask Clock to re-arm its
// alarm if it stopped (as perchlight-hooks).
const WATCHDOG_MS = 60_000;
let watchdogAt = 0;
export function resetWatchdog() {
  watchdogAt = 0;
}

function watchdog(app, ctx) {
  const now = Date.now();
  if (!app.env.CLOCK || now - watchdogAt < WATCHDOG_MS) return;
  watchdogAt = now;
  ctx.waitUntil(
    clockStub(app.env)
      .ensureAlarm()
      .catch((err) => console.error(`watchdog: ${err instanceof Error ? err.message : String(err)}`)),
  );
}

const B = "([a-z0-9][a-z0-9_-]{0,39})";
const TOK = "([A-Za-z0-9_-]{1,64})";

export function makeWorker(raw, terms = {}) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const path = url.pathname;
      const m = request.method;
      const app = makeApp(raw, terms, env, { origin: url.origin, ctx });
      try {
        if (path.length + url.search.length > MAX_URL) return text("URL too long\n", 414);
        let g;
        let res;
        if (path === "/tick") {
          watchdog(app, ctx);
          return text("ok\n");
        }
        if (path === "/") res = message("perchlight-beta", "A private beta portal. If you were invited, open the link in your email, or sign in.");
        else if ((g = new RegExp(`^/b/${B}$`).exec(path)) && m === "GET") res = await handleApplyPage(request, app, g[1], url);
        else if ((g = new RegExp(`^/b/${B}/apply$`).exec(path)) && m === "POST") res = await handleApply(request, app, g[1]);
        else if ((g = new RegExp(`^/i/${TOK}$`).exec(path)) && m === "GET") res = await handleInvitePage(request, app, g[1]);
        else if ((g = new RegExp(`^/i/${TOK}/claim$`).exec(path)) && m === "POST") res = await handleClaim(request, app, g[1]);
        else if (path === "/signin" && m === "GET") res = signinForm(app, { ended: url.searchParams.get("ended") === "1" });
        else if (path === "/signin" && m === "POST") res = await handleSignin(request, app);
        else if ((g = new RegExp(`^/s/${TOK}$`).exec(path)) && m === "GET") res = await handleSigninPage(request, app, g[1]);
        else if ((g = new RegExp(`^/s/${TOK}$`).exec(path)) && m === "POST") res = await handleSigninClaim(request, app, g[1]);
        else if (path === "/t" && m === "GET") res = await handleTesterHome(request, app);
        else if (path === "/t/me/export" && m === "GET") res = await handleExport(request, app);
        else if (path === "/t/me/delete" && m === "POST") res = await handleDelete(request, app);
        else if (path === "/t/me/reminders" && m === "POST") res = await handleReminders(request, app);
        else if ((g = new RegExp(`^/t/${B}$`).exec(path)) && m === "GET") res = await handleTesterPage(request, app, g[1], url);
        else if ((g = new RegExp(`^/t/${B}/terms$`).exec(path)) && m === "POST") res = await handleReaccept(request, app, g[1]);
        else if ((g = new RegExp(`^/t/${B}/survey/${B}$`).exec(path)) && m === "POST") res = await handleSurvey(request, app, g[1], g[2]);
        else if ((g = new RegExp(`^/t/${B}/bugs$`).exec(path)) && m === "POST") res = await handleBug(request, app, g[1]);
        else if ((g = new RegExp(`^/t/${B}/withdraw$`).exec(path)) && m === "POST") res = await handleWithdraw(request, app, g[1]);
        else if ((g = /^\/d\/([^/]{1,64})$/.exec(path)) && m === "GET") res = await handleDownload(request, app, g[1], url);
        else if (path.startsWith("/api/")) res = await handleAdmin(request, app, path.slice(5));
        else return text("not found\n", 404);
        watchdog(app, ctx);
        return res;
      } catch (err) {
        console.error(`${m} ${path.replace(/\/(i|s)\/[^/]+/, "/$1/<token>")}: ${err instanceof Error ? err.stack : String(err)}`);
        if (path.startsWith("/api/")) return fail(500, "Something went wrong.");
        return path.startsWith("/d/") ? json({ ok: false }, 503) : message("Something went wrong", "Please try again later.", 503);
      }
    },
  };
}
