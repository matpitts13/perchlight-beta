# perchlight-beta

A free, self-hosted portal for private beta tests and advance-reader copies (ARCs), on your own Cloudflare account: one Worker, one D1 database and one small Durable Object (`Clock`), plus R2 only if you turn it on. For indie game developers, app makers and authors who now run betas from a spreadsheet, a form and a shared Drive folder.

- **Applications** on a public page per beta (`/b/<beta>`) with your screening questions, Turnstile and a honeypot. Everyone gets the same "Thanks, we'll be in touch", so the form can't be used to find out who has applied.
- **Approval** in the Perchlight desktop app (or the admin API). Approved people get an invite email with a single-use link that expires.
- **Terms / NDA.** The invite page shows your terms; the tester types their full name and accepts. The log keeps the version, the SHA-256 of the exact text shown, the name and the time.
- **Builds.** Each tester gets their own signed download links, valid 15 minutes, and every download is logged. Files stay where they are: a link you host (itch.io, TestFlight, Steam playtest, Play testing, Drive), a release in a **private GitHub repository**, or R2.
- **Feedback.** A survey per build, bug reports with up to 2 screenshots, and a dashboard of who has downloaded and who has given feedback.
- **Reminders** from the `Clock` alarm (no cron trigger), **revoke** on the tester's next request, and **export / delete** for every tester.

The design is in [docs/SDD.md](docs/SDD.md).

## Set up

You need a Cloudflare account (the free plan is enough), a [Resend](https://resend.com) account (the free plan: 100 emails a day, 3,000 a month) and Node 22+.

1. **Email to testers.** Verify your sending domain in Resend and create an API key. Put the sender in `wrangler.jsonc` `vars.MAIL_FROM` (e.g. `"Hollow Lantern <beta@example.com>"`).
2. **Email to you (free, optional).** Cloudflare dashboard → your domain → Email → Email Routing → enable it and add your address under *Destination addresses*. Put that address in `vars.OWNER_EMAIL`. New applications, bugs and broken builds are grouped into at most one email every 30 minutes; it doesn't use Resend quota.
3. **Turnstile.** Create a widget (free) and put its site key in `vars.TURNSTILE_SITE_KEY`; the secret key is a secret (below).
4. **`beta.json`** (at the repo root) holds your betas, builds and surveys; terms texts go in `terms/*.md` and are listed in `src/terms.js`. `npm test` checks the shipped file.
5. **Deploy.** Keep your own copy of `wrangler.jsonc` as `wrangler.mine.jsonc` (gitignored) for the database id and domain.
   ```sh
   npm install
   npx wrangler d1 create perchlight-beta           # copy the database_id into wrangler.mine.jsonc
   npx wrangler secret put ADMIN_TOKEN              # 16+ random characters: openssl rand -hex 32
   npx wrangler secret put LINK_SECRET              # 32+ random characters
   npx wrangler secret put SESSION_SECRET           # 32+ random characters
   npx wrangler secret put IP_SALT                  # 16+ random characters
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put TURNSTILE_SECRET_KEY
   npx wrangler secret put GITHUB_TOKEN             # optional: builds with source "github"
   npx wrangler d1 migrations apply DB --remote -c wrangler.mine.jsonc
   npx wrangler deploy -c wrangler.mine.jsonc
   ```
   Set `vars.PUBLIC_URL` to the Worker's URL (e.g. `https://beta.example.com`): emails link to it, and every form checks `Origin` against it.
6. **Check it works.** `curl https://<host>/tick` arms `Clock`. Then `curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<host>/api/betas` shows config errors, missing secrets and a daily estimate, and `POST /api/test-email` sends one email to `OWNER_EMAIL`.

Never commit `.dev.vars`; `.dev.vars.example` lists every secret. For local runs (`npm run dev`), Cloudflare's Turnstile test keys work.

## `beta.json`

```jsonc
{
  "betas": {
    "hollow-lantern": {
      "name": "Hollow Lantern closed beta", "type": "game", "status": "open",   // draft | open | closed
      "maxTesters": 150, "endsAt": "2027-01-31",
      "sources": ["list", "discord", "site"],                                   // allowed ?src= values
      "questions": [ { "id": "platform", "type": "multi", "label": "What will you play on?", "options": ["Windows", "Steam Deck"], "required": true } ],
      "terms": { "file": "terms/hollow-lantern-nda.md", "version": "2026-11-01" },
      "keys": { "product": "hollow-lantern", "edition": "beta", "expiresDays": 90 },   // optional, perchlight-keys
      "reminders": { "unclaimedInvite": 5, "newBuild": true, "surveyNudge": 3, "endingSoon": 3 },  // false turns one off
      "retention": { "declinedDays": 30, "afterCloseDays": 180, "acceptanceDays": 730 },
      "inviteDays": 14, "downloadsPerDay": 30, "closeGraceDays": 7, "keepBugs": false
    }
  },
  "builds": {
    "hl-0.4-win": { "beta": "hollow-lantern", "label": "0.4 Windows", "source": "github", "repo": "you/hl-builds", "tag": "v0.4.0", "asset": "HL-0.4-win.zip", "survey": "hl-0.4" },
    "hl-steam":   { "beta": "hollow-lantern", "label": "Steam playtest", "source": "link", "url": "https://store.steampowered.com/app/000000/" },
    "hl-deck":    { "beta": "hollow-lantern", "label": "Deck build", "source": "r2", "key": "builds/hl-deck.zip", "groups": ["deck"] }
  },
  "surveys": { "hl-0.4": { "questions": [ { "id": "fun", "type": "rating", "label": "How fun was 0.4?" } ] } },
  "email": { "dailyCap": 90, "monthlyCap": 2800 },
  "screenshots": { "store": "d1", "maxBytes": "400KB", "perBug": 2, "totalCap": "150MB" }
}
```

- Up to **10 betas** per deployment; more are switched off with a reason. A beta or build with a mistake is switched off and the rest keep working (`GET /api/betas`).
- Question types: `text` (200), `longtext` (up to 2,000), `choice`, `multi`, `checkbox`, `number`; surveys add `rating` (1–5). Up to 20 questions.
- A `link` URL must be `https:`, carry no user name or password, and not be this deployment's host, an IP literal in a private, loopback, link-local or CGNAT range, `localhost` or `*.local`. It's only a redirect target; the Worker never fetches it.
- Changing a beta's `terms.version` makes every active tester accept again before their next download.
- Builds can also be added at runtime: `POST /api/builds`.

## How it works

**Applying.** `POST /b/<beta>/apply` answers the same `200` page for a new application, a repeat from the same email (the answers are updated; no second row), a closed beta (stored on the waitlist) and a blocked address. No email is sent on apply. Rate limits: 5 an hour per IP (hashed with a daily salt), 500 a day per beta.

**Invites, claim-then-act.** Approving creates the invite and its email in one D1 batch; `Clock` sends it. The link `https://<host>/i/<token>` carries 128 bits; only its SHA-256 is stored. `GET` only shows the page (mail scanners open links). The claim is a `POST` with the terms accepted: one conditional `UPDATE … RETURNING` claims the invite, and every later statement in the same batch is guarded by that claim, so a second click, a second tab or a replay finds nothing to claim. Unknown, used, expired and revoked links all get one page. Invites are personal: whoever claims a forwarded invite first becomes the tester (their typed name is logged); revoke and re-invite if that happens.

**Sign-in.** Testers sign in with an emailed single-use link (30 minutes; `POST /signin` always answers `202`). The session is a signed cookie (`HttpOnly; Secure; SameSite=Lax`, 30 days) checked against the tester's `session_ver` on every request; revoking bumps it.

**Downloads.** The tester page links to `/d/<build>?t=…&exp=…&sig=…`, an HMAC valid 15 minutes. It's checked (in constant time), then the tester's status and terms, the build's availability and groups, and the daily limit (30). Every failure is one `403` page; every attempt is logged (no IP). `link` redirects; `github` asks the GitHub API and redirects to GitHub's short-lived URL (or streams it); `r2` streams with `Range`. The log can only say "download started": a redirect ends the Worker's view.

**Leak tracing is a deterrent, not protection.** Each tester has a reader code, signed and logged downloads, and optionally their own perchlight-keys key. A shared `link` URL or a re-uploaded file can't be traced. None of this stops a determined leaker. Anything a tester downloaded before you revoke them stays downloaded.

**Feedback.** One response per tester per survey, editable until the beta closes. Bug reports: title (200), details (10 KB), severity, platform, build and up to 2 screenshots (PNG, JPEG or WebP, checked by their first bytes, 400 KB each; the page shrinks them to 1,600 px first). Over the deployment-wide cap (150 MB in D1) a bug is saved without its screenshots and says so. Screenshots are served only through the admin API, as attachments with `nosniff` and `CSP: sandbox`. Screenshots are stored as sent (shrinking in the browser re-encodes them, which drops EXIF).

## No cron trigger: how work is timed

All timed work runs on the `Clock` Durable Object's alarm, every 5 minutes (sooner when a sign-in link is waiting). One run sets its next alarm first, then applies the desktop app's actions, sends due email, makes one perchlight-keys call, queues reminders, expires invites, runs retention (hourly) and sends owner notices, and writes its state to its SQLite every run. Persistent failures back off (5, 10, 20, 40, then 60 minutes). Any request and `GET /tick` re-arm the alarm if it stopped.

**Email is the binding limit.** Resend's free plan allows 100 a day and 3,000 a month; the defaults (`dailyCap` 90, `monthlyCap` 2,800) leave room for tests and for perchlight-keys if both share one Resend account. Only `Clock` sends, at most 30 a run, in this order: sign-in links, invites, new-build notices, reminders. Sign-in links expire in 30 minutes, so they may also use a small reserve above the cap (`email.signinReserve`, 10; `dailyCap` + reserve must stay within 100). Everything else that doesn't fit waits for the next UTC day: inviting 150 people takes 2 days, and `POST /api/applications/decide` says so ("150 invites: sent over 2 days"). Every send is claimed first and uses a Resend idempotency key, so the alarm running twice never sends twice.

**Reminders** (each can be turned off per beta; each tester can turn them all off): an invite unclaimed after 5 days, a new build, a survey with no answer 3 days after a download, and a beta ending in 3 days. Each is queued once (a unique key per occurrence).

## perchlight-keys and perchlight-list

- **perchlight-keys** (betas with `"keys"`): after a claim, `Clock` asks perchlight-keys for the tester's key (`POST /api/licenses`, `source: "import"`, `source_ref: "beta:<beta>:<tester>"`, so a retry can't create a second key); perchlight-keys emails it from its own Resend quota. Revoke and delete revoke the key there. **A `KEYS` service binding is required** (`"services"` in your `wrangler.mine.jsonc`, plus the `KEYS_TOKEN` secret): perchlight-keys has only a full admin token today, so the config check warns that `KEYS_TOKEN` grants full admin there. A scoped issue/revoke token in perchlight-keys is a planned follow-up; `KEYS_URL` works only with `KEYS_TOKEN_SCOPED=1`, once that token exists.
- **perchlight-list**: no API call and no shared data. Announce your beta with a link to `https://<host>/b/<beta>?src=list`; the dashboard shows applications by source. Unsubscribing from the list doesn't touch the beta, and the reverse.

## Admin API

`Authorization: Bearer <ADMIN_TOKEN>` (compared in constant time; refused while the token is under 16 characters).

| Endpoint | What it does |
|---|---|
| `GET /api/betas` · `POST /api/betas/:id/close` | Betas, config errors, missing secrets, a daily estimate; close (revokes open invites, closes surveys, stops downloads after `closeGraceDays`, starts the retention clock). |
| `GET /api/applications?beta=&status=` · `POST /api/applications/decide {ids, action}` | List; approve, decline, waitlist or block in bulk. |
| `POST /api/invites {beta, email, name?}` · `POST /api/invites/:id/resend` · `POST /api/invites/:id/revoke` | Manual invites. |
| `GET /api/testers/:id` · `POST /api/testers/:id/revoke` · `GET /api/testers/:id/export` · `DELETE /api/testers/:id` | One tester. |
| `GET/POST /api/builds` · `PATCH /api/builds/:id` · `POST /api/builds/:id/resolve` | Runtime builds; re-resolve a GitHub asset id. |
| `GET /api/downloads` · `/api/feedback?survey=` · `/api/bugs` · `/api/bugs/:id/images/:n` | Activity, responses, bugs, screenshots. |
| `GET /api/dashboard?beta=` · `GET /api/acceptances?beta=` | Dashboard; the acceptance log. |
| `GET /api/deliveries?status=` · `POST /api/deliveries/:id/retry` · `POST /api/test-email` | The email queue. |
| `GET /api/footprint` · `POST /api/housekeeping` | Today's counts; run `Clock` now. |

## Perchlight desktop app

`perchlight/perchlight.json` adds screens for Applications (*Approve*, *Decline*, *Waitlist*, *Block*), Testers (*Revoke*, *Re-send invite*), Builds, Downloads, Feedback, Bugs (status actions), Acceptances and the Email queue (*Try again*). Replace `YOUR-D1-DATABASE-ID`. The app writes `action_requested` to D1 and doesn't wake the Worker, so its actions take effect on `Clock`'s next run (5 minutes at most). The manifest schema has no row filter, so both the Applications and Testers screens list every tester with a status column.

## Security notes

- Tokens (invites, sign-in links) are looked up by SHA-256, never compared byte by byte. The admin token, CSRF values, download signatures and session cookies are compared in constant time (hash-then-compare or `crypto.subtle.verify`).
- Every state-changing form checks `Origin` against `PUBLIC_URL`, and tester forms carry a per-session CSRF value. Pages set a Content-Security-Policy (no inline script except the screenshot shrinker, by hash, and Turnstile), `X-Frame-Options: DENY` and `Referrer-Policy: same-origin` (no `Referer` leaves the site; `no-referrer` would make browsers send `Origin: null` on form posts). Redirects carry `no-referrer`.
- Size limits: name 100, email 254, answers as configured, JSON or form bodies 32 KB, bug forms 900 KB, URLs 2 KB; bodies over the limit are refused before they're read.
- Every SQL statement is parameterised. The only owner-configured URL the Worker fetches is `KEYS_URL` (checked with perchlight-hooks' SSRF rules, redirects not followed); a service binding is preferred and required by default. GitHub, Resend and Turnstile hosts are fixed.

## Privacy

No IP address is stored; rate limits use an HMAC of the IP with a daily salt, kept 48 hours. Each tester can download everything held about them (`GET /t/me/export`, JSON, covering every beta they're in) and delete it (`POST /t/me/delete`). Deletion removes their rows, screenshots, responses, bugs (or, with `keepBugs`, clears the tester id from them) and queued email, and revokes their perchlight-keys key. The only thing kept is a **pseudonymised acceptance** (email HMAC, terms version, text hash, time) for `acceptanceDays` (730 by default; 0 deletes it too), because the NDA record protects both sides; check your local law. Retention is per beta: declined applicants after 30 days (blocked ones keep only an email HMAC, so they stay blocked), sign-in rows after a day, events and downloads after 180 days, and everything about a closed beta's testers after `afterCloseDays`. Tester emails are transactional (to people who applied); still read up on CAN-SPAM and GDPR for your situation, as perchlight-list's README explains.

## What it costs

Nothing inside the free plans (Workers Free, D1 Free, Durable Objects Free with SQLite storage, Resend free, Turnstile, `send_email` to your own address). The SDD's busy-week example (one game beta, 25 applications and 100 active testers a day, 60 tester emails) uses about 1,500 D1 rows written (1.5%), about 320 `Clock` runs (0.3% of Durable Object requests) and 60% of the daily email cap; screenshots in D1 are the storage risk (the 150 MB cap is reached after about a month at 10 bugs a day). `GET /api/footprint` shows today's counts. R2 is optional because it asks for a payment method.

## Tested, and not tested

- **`npm test`: 111 tests** with vitest and the Workers pool. D1, the `Clock` Durable Object and R2 run for real in Miniflare; Resend, GitHub, Turnstile and perchlight-keys are stubbed. They cover:
  - apply: byte-identical answers for new / repeat / closed-beta waitlist / blocked; one row with the latest answers; Turnstile missing, failed or unreachable (nothing stored); honeypot; validation; 32 KB and 2 KB limits; 5 an hour per IP; `?src=` allow-list; draft and unknown betas; D1 refusing the write (503); page security headers
  - approve and invite: an app action applied by `Clock` sends exactly one invite; `GET` ten times changes nothing; one claim wins, a second gets the uniform page (or `/t` with the winner's session); three concurrent claims → one; expired, revoked, unknown and malformed tokens → one page; re-send replaces the token; changed terms → nothing claimed; Origin, CSRF and acceptance checks; manual invites; `maxTesters` → waitlist; bulk decisions
  - NDA: the acceptance row (tester, version, SHA-256 of the exact text, typed name, time); re-acceptance after a version change; the log is append-only (D1 triggers)
  - downloads: per-tester signed 15-minute links; `link` 302; `github` resolve-once and 302 with no file bytes, streamed 200, upstream failure logged once a day; `r2` with `Range` (206); expiry, altered parameters, revoke and the daily limit → one 403, every attempt logged; groups; future builds; a closed beta's grace period; `link` URLs to private addresses or the deployment's own host refused
  - feedback: surveys (one per tester, editable, closed with the beta); two 400 KB screenshots stored; a third image, a 500 KB image and HTML renamed `.png` refused; over the cap → saved without images; 900 KB limit; 20 bugs a day; screenshots served as sandboxed attachments
  - email: cap arithmetic across the day and month boundary; 150 approvals at a cap of 90 → 90 on day one and 60 on day two, no duplicate, ≤30 a run and under 45 subrequests a run; sign-in links before queued invites; `throttled` → next day; `unknown` retried with the same key; interrupted claims; dropped mail for revoked invites
  - reminders via the alarm: unclaimed invite once (not after a claim, not with reminders off), new build once, survey nudge once (not after an answer), ending soon, per-beta switches
  - `Clock`: alarm set first, hot state persisted every run and reloaded, backoff 5/10/20/40/60 minutes on persistent failures, `ensureAlarm`, grouped owner notices
  - privacy: export of every row across betas; delete leaving only the pseudonymised acceptance (removed after 730 days); admin export/delete; withdraw; retention of declined, blocked and closed-beta testers
  - sessions: tampered, re-versioned and expired cookies; `last_seen_day` once a day; sign-in always 202, single use, 30 minutes, 1 per 10 minutes per email, Turnstile; Origin and CSRF on tester forms; revoke → next request to sign-in, sign-in sends nothing
  - review regressions: forms accepted with `Origin: null` plus `Sec-Fetch-Site: same-origin` (and pages use `Referrer-Policy: same-origin`); no 2-second loop when email isn't configured; 150 app actions within D1's parameter limit; at most 100 builds; emails counted in the run budget; runs never overlap; sign-in links sent from a reserve when the cap is used up; concurrent bug reports held under the screenshot cap
  - admin auth (wrong, missing, short token); dashboard; footprint under 2,000 rows written; builds API; deliveries; the config check (10-beta limit, one bad beta or build switched off) and the shipped `beta.json`; perchlight-hooks' SSRF rules
- **Not tested:**
  - **perchlight-keys for real.** Beta codes against perchlight-keys' documented admin API (`POST /api/licenses`, `POST /api/licenses/:id/revoke`) through a stubbed service binding; it hasn't run against a local perchlight-keys Worker, and the scoped issue/revoke token in perchlight-keys doesn't exist yet (TECH_DEBT.md).
  - On a real Cloudflare account (free, but needs you): deploying; real Resend sends; Turnstile with a real widget; a real private GitHub release with a fine-grained token; `send_email` owner notices; the `Clock` alarm firing on its own (tests drive runs directly); production subrequest counting and CPU; the desktop app reading `perchlight/perchlight.json`.
  - Costs money or needs a card: R2 on a real account (tested only against Miniflare's local R2); Resend above the free plan; TestFlight, Steam playtest and Google Play testing links (beta only redirects to them); Workers Paid.
  - Not built in v0.1 (SDD "Should"): EPUB/PDF reader-code marking (`prepare-ebook`), notification webhooks, an "application received" email, CSV export.

## Differences from the SDD

- Invite and sign-in tokens are `HMAC(LINK_SECRET, kind/row id)` cut to 128 bits rather than stored random bits: only the hash is stored, and a retried send carries the same link under the same Resend idempotency key.
- "Send once" for reminders is a unique key per occurrence on the D1 email queue (one `INSERT … SELECT` per kind), not a `reminders_sent` table in `Clock`'s SQLite; `Clock`'s SQLite holds its run state and the email counts.
- The perchlight-keys request after a claim is queued and sent by `Clock` (woken at once) rather than from the request's `waitUntil`.
- A closed beta's page shows the form as a waitlist (the acceptance criteria need it); draft and unknown betas show "not open". Input mistakes and a failed Turnstile check answer `400` with the form, since they depend only on the visitor's own input.
- Downloads log three more refusal kinds (`refused_invalid`, `refused_terms`, `refused_unavailable`).
- Terms are shown as plain text; the hash is of the exact file text. The export lists screenshot metadata, not the image bytes.
- A `Clock` run makes up to about 10 D1 calls (not 3), still within 45 subrequests with 30 emails.

## License

MIT. See [LICENSE](LICENSE). Not affiliated with Cloudflare, Resend, GitHub, Valve, Apple, Google or itch.io.
