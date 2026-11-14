# SDD: perchlight-beta

**Version:** 0.1
**Date:** 2026-11-12
**Status:** Approved 2026-11-12 (all 9 open questions decided as recommended; see "Decisions")

## Summary

A free, self-hosted portal for private beta tests and advance-reader copies (ARCs), running on your own Cloudflare account: one Worker, one D1 database and one small Durable Object, plus R2 only if you choose to turn it on. It's for indie game developers, app makers and authors who now run betas from a spreadsheet, a Google Form and a shared Drive folder.

1. **Applications.** A public page per beta (`/b/<beta>`) with your screening questions and Turnstile. Every applicant gets the same "Thanks, we'll be in touch" whatever happened, so the form can't be used to find out who has applied.
2. **Approval in the Perchlight desktop app.** You approve or decline applicants on an *Applications* screen. Approved people get an invite email with a single-use link that expires.
3. **Invite, terms, access.** The invite page shows your NDA or reader terms. The tester accepts (the version, the text's hash and the time are logged), the invite is claimed exactly once, and they land on their tester page.
4. **Builds and files.** Each tester gets their own signed download links, and every download is logged. The files stay where they already are: a link you host (itch.io restricted page, TestFlight, Steam playtest, Google Play testing, Drive), a release in a **private GitHub repository**, or R2 (optional, since R2 asks for a payment method).
5. **Feedback.** A survey per build, bug reports with up to 2 screenshots, and a dashboard of who has downloaded and who has given feedback.
6. **Leak tracing, honestly.** A deterrent, not protection. Each tester has a short reader code. Their downloads are signed and logged, game and app testers can get their own perchlight-keys key, and (Should) EPUB and PDF copies can carry the reader's code on a page.
7. **Reminders** come from a Durable Object alarm (no cron trigger). **Revoke** takes effect on the tester's next request. **Export and delete** are open to every tester and to you, and **retention** is set per beta.

It joins the rest of the Perchlight family through documented APIs, never shared code at runtime or a shared database: **perchlight-keys** issues and revokes beta keys through its admin API, and **perchlight-list** sends a recruiting announcement that links to the application page.

## Why

- Indie betas today mean a form service, a spreadsheet, manual emails and a public Drive link that anyone can forward. There's no record of who downloaded which build, and no record of who agreed to the NDA, or which version of it they agreed to.
- Hosted ARC and beta services charge per campaign or per seat. Their prices weren't checked for this draft (see "Couldn't verify"), so this SDD makes no price claims about them.
- Your testers' data stays in your account, and there's no subscription. The free plan has room for a beta of a few hundred testers. The one tight limit is email (Resend's free plan allows 100 a day), and the design schedules around it.

## Requirements

### Must have

**Recruiting and screening**
- Up to 10 betas per deployment (`beta.json`), each `draft` | `open` | `closed`, with a type (`game`, `app`, `book`) that sets the default wording.
- An application page with name, email and up to 20 screening questions (`text`, `longtext` up to 2,000 characters, `choice`, `multi`, `checkbox`, `number`). A question can be required. Turnstile is required on an open beta (free, unlimited verifications, up to 20 widgets ([Turnstile plans](https://developers.cloudflare.com/turnstile/plans/))), and a honeypot field is added as in perchlight-list.
- **One uniform answer** (same status, body and headers, with the work done in `waitUntil`) for a new application, a repeat from the same email, a closed beta's waitlist, and an address you've blocked. A repeat updates the answers and doesn't create a second row.
- No email is sent on apply by default (it saves quota and stops the form from being used to send mail to other people). The invite email is what proves the person owns the address.
- An optional `?src=` tag (from a list of allowed values set per beta, such as `list`, `discord`, `site`), stored with the application so you can see where testers came from.

**Approval and invites**
- An *Applications* screen in the desktop app (`perchlight/perchlight.json`) with the actions *Approve*, *Decline*, *Waitlist* and *Block*. Each action sets `action_requested`, as perchlight-keys does. The Durable Object applies it within 5 minutes (the app writes to D1 and doesn't wake the Worker). The admin API applies the same actions at once and in bulk.
- **Invite links:** `https://<host>/i/<token>`, 128 random bits, with only the SHA-256 stored. Single-use, expiring after 14 days by default (1–60 settable), revocable, and re-sendable (a new token replaces the old one, which stops working).
- **Claim-then-act:** `GET /i/<token>` only shows the page and changes nothing, because mail scanners open links. The claim is a `POST` with the terms accepted: one conditional `UPDATE invites SET status='claimed' … WHERE token_hash=? AND status='sent' AND expires_at>? RETURNING`. Only after it succeeds are the tester activated, the acceptance logged, the session set and any key requested.
- A manual invite (`POST /api/invites {beta, email, name?}`) for people you recruit yourself.

**Terms and NDA**
- Terms are Markdown files per beta, with a `version`. The acceptance log stores tester, beta, version, the SHA-256 of the exact text shown, the typed full name, the time (UTC) and how it was given (`invite` | `re-accept`). The log can only be added to; the app shows it read-only.
- When a beta's terms version changes, active testers are asked to accept again on their next visit, before they can download.

**Builds and downloads**
- A build has a label, platform, notes, an available-from time, an optional expiry, and a **source**:
  - `link` (default): a URL you host. The Worker redirects to it; it never fetches it.
  - `github`: an asset of a release in a private GitHub repository. The Worker calls the GitHub API with a fine-grained token (read-only, one repository) and redirects the tester to the short-lived download URL GitHub returns.
  - `r2` (optional): an object in a private R2 bucket, streamed by the Worker with `Range` support.
- **Per-tester signed URLs:** the tester page links to `/d/<build>?t=<tester>&exp=<+15 min>&sig=<HMAC(LINK_SECRET, build.tester.exp)>`. The URL is checked against the tester's current status (revoked means refused), logged (tester, build, time, source, result, data centre; no IP), and counted against a per-tester daily limit.
- Builds can be limited to some testers (`groups`), such as "Steam Deck testers".

**Feedback**
- A survey per build (the same question types as applications, plus a 1–5 `rating`), one response per tester per survey, which they can edit until the survey closes.
- Bug reports: title (200), steps and details (10 KB), severity, platform and build. Up to **2 screenshots**, PNG, JPEG or WebP, checked by their first bytes, **at most 400 KB each**. The page shrinks images in the browser to 1,600 px on the longest side before uploading; without JavaScript the server still applies the limit. Statuses: `new`, `triaged`, `fixed`, `wontfix`, `duplicate`.
- **Dashboard** (desktop app screens and `GET /api/dashboard`): per beta, applicants, invited, claimed, active and revoked; per build, downloads, distinct testers, survey responses and bug count; testers who haven't downloaded, and those who have downloaded but given no feedback.

**Revoke, reminders, privacy**
- **Revoke** a tester (app or API): their status becomes `revoked` and `session_ver` goes up, so their cookie stops working on the next request. Any open invite is revoked, unexpired download URLs are refused, and perchlight-keys is told to revoke their key if one was issued. Anything they downloaded before stays downloaded (the README says so).
- **Reminders** (one Durable Object, `Clock`, one alarm, **no cron trigger**): an invite that hasn't been claimed after 5 days (once), a new build ("Build 0.4 is ready", once per build), a survey with no answer 3 days after the tester downloaded (once), and a beta ending in 3 days. Each kind can be turned off per beta, and each tester can turn off everything except invites.
- **Privacy:** each tester can export their data (`GET /t/me/export`, JSON) and delete it (`POST /t/me/delete`, which withdraws them first). You can do the same through the admin API. Retention is set per beta (below). No IP addresses are stored. Rate limits use an HMAC of the IP with a salt that changes daily, kept 48 hours (as perchlight-keys).

**Everything**
- Admin API behind `ADMIN_TOKEN` (bearer, constant-time compare, refused if under 16 characters), as the rest of the family.
- Email through Resend, using perchlight-keys' copy of perchlight-list's mail module. Every send is claimed first, then sent; retries follow perchlight-forms' schedule; Resend idempotency keys are used; and the daily and monthly caps sit below Resend's free plan (see "Email"). Notices to you (a new application, a new bug) go by `send_email` to your verified address, which is free and doesn't use Resend quota.
- Its footprint in numbers (`GET /api/footprint`), plus a config check that estimates daily writes and emails.
- A Deploy to Cloudflare button, `npm test` (vitest with `@cloudflare/vitest-pool-workers`), README, MIT licence, no runtime dependencies, graphify when the repo is created, and GitHub Actions CI on the free tier.

### Should have

- **Reader-code marking for EPUB and PDF** by a same-length splice (see "Leak tracing"), prepared once by a local script (`npm run prepare-ebook`).
- A notification webhook to you (Discord, Slack, ntfy, signed JSON) for new applications and bugs, using perchlight-status' `notify.js`.
- An optional "application received" email for each beta (off by default).
- `POST /api/betas/:id/close`: closes surveys, stops new downloads after a grace period, and starts the retention clock.
- CSV export of applications, feedback and bugs (formula characters escaped, as perchlight-forms).

### Out of scope (v0.1), with reasons

- **A web reader for ebooks** (reading in the browser, with invisible zero-width markers in the text). Serving and marking every page view costs Worker requests and CPU, and copy-paste or a screenshot defeats it anyway.
- **Watermarking game or app binaries.** Changing an executable per tester means rebuilding or re-signing it, which a Worker can't do within 10 ms of CPU, and code signing would break. A per-tester perchlight-keys key does the same job better.
- **Hosting files in D1** (2 MB per row, 500 MB per database ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/))). Builds are linked, kept on GitHub, or kept in R2.
- **Tester accounts with passwords.** Sign-in is by emailed link with a signed cookie (as perchlight-keys' "resend my key").
- **In-app crash reporting.** That's perchlight-crashes; a bug report can quote a crash id.
- **Paying testers, rewards or giveaways.**
- **Checking that an applicant is a perchlight-list subscriber.** perchlight-list has no lookup API, and adding one would let anyone test whether an address is on the list. The `src=list` tag is enough.
- **Cron triggers.** The account is at its cron limit; all timed work runs on the `Clock` alarm.

## Technical design

### Pieces

```
Applicants / testers                  Your Cloudflare account
────────────────────                  ─────────────────────────────────────────────────────────
Browser ──GET/POST /b/:beta──────▶    Worker
        ──GET /i/:token, POST claim─▶  ├─ apply (Turnstile siteverify, uniform answer)
        ──/signin, /s/:token───────▶  ├─ invites, sign-in links, signed cookie session
        ──/t/* (cookie)─────────────▶  ├─ tester page, surveys, bugs (screenshots), export/delete
        ──/d/:build?t&exp&sig───────▶  ├─ download: verify, log, then
                                       │     link:   302 to your URL
                                       │     github: GitHub API (1 subrequest) → 302 to GitHub's URL
                                       │     r2:     stream from the R2 binding (optional)
You ──▶ /api/* (ADMIN_TOKEN)           ├─ admin API, dashboard, footprint
Perchlight desktop app ──▶ D1 (direct) ├──▶ D1: betas, testers, invites, acceptances, builds,
                                       │        downloads, responses, bugs, bug_images, deliveries,
                                       │        events, rate, state
                                       ├──▶ Resend (tester email) · send_email (your own address)
                                       ├──▶ perchlight-keys /api/licenses (service binding or URL)
                                       └──▶ Durable Object "Clock" (SQLite, Free plan), one instance,
                                              one alarm ≤ 5 min away: app actions, email queue,
                                              reminders, invite expiry, retention
```

- **Worker** (`src/`): every HTTP route. It never sends reminders and never empties the email queue; those belong to `Clock`, so the daily cap is enforced in one place. Transactional email that a tester has just asked for (a sign-in link, an invite re-send) is claimed in D1 and handed to `Clock`, which sends it within seconds.
- **`Clock` Durable Object**: one instance, built the same way as perchlight-hooks' Scheduler. It sets its next alarm first, keeps its hot state in SQLite every run, and is re-armed lazily by `ensureAlarm()` from any request or `GET /tick`. Durable Objects on Free are SQLite-backed only ([DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)). One object can't be billed more than 24 hours of wall time a day, so DO duration stays under the free 13,000 GB-s ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
- **D1** `DB` holds everything the desktop app shows. **R2** `FILES` is bound only when a build uses `source: "r2"` or `screenshots: "r2"`.

### Shared with the family (copied, not imported)

| From | What | Changes for beta |
|---|---|---|
| perchlight-keys `src/lib/mail/*` (itself copied from perchlight-list) | Resend sender, result types (`sent`, `retry`, `throttled`, `config`, `unknown`, `conflict`), idempotency key | sent only by `Clock`, under the daily and monthly caps |
| perchlight-forms `src/lib/deliveries.js` | claim-then-send, retries at 1 / 5 / 30 min, 2 h, 12 h | a `throttled` result, or reaching the cap, moves the delivery to the next UTC day, not the retry ladder |
| perchlight-forms `src/lib/turnstile.js`, `files.js` signing | siteverify; `HMAC(LINK_SECRET, …)` signed links served with `nosniff` and `CSP: sandbox` | tester id included in what's signed |
| perchlight-keys `rate.js`, "resend without enumeration" | IP-hash and per-email counters in D1, constant answer with the work in `waitUntil` | used for apply, sign-in and claim |
| perchlight-hooks Scheduler, `net.js` SSRF rules | alarm pattern, subrequest budget (45 of 50), URL checks | the grid holds email batches and reminders |
| perchlight-keys `admin.js` | `Authorization: Bearer <ADMIN_TOKEN>`, `action_requested` columns set by the app | — |

### Config

`beta.json` in your copy of the repo, imported at build time and checked by `npm test` and once per isolate. A beta with a mistake is switched off with the reason (`GET /api/betas`), and the other betas keep working. Builds can also be added at runtime (`POST /api/builds`, stored in D1).

```jsonc
{
  "betas": {
    "hollow-lantern": {
      "name": "Hollow Lantern closed beta", "type": "game", "status": "open",
      "maxTesters": 150, "endsAt": "2027-01-31",
      "sources": ["list", "discord", "site"],          // allowed ?src= values
      "questions": [
        { "id": "platform", "type": "multi", "label": "What will you play on?", "options": ["Windows", "Steam Deck", "macOS"], "required": true },
        { "id": "hours", "type": "choice", "label": "Hours a week for testing", "options": ["<2", "2-5", "5+"] },
        { "id": "why", "type": "longtext", "label": "What do you like in roguelikes?", "max": 1000 }
      ],
      "terms": { "file": "terms/hollow-lantern-nda.md", "version": "2026-11-01" },
      "keys": { "product": "hollow-lantern", "edition": "beta", "expiresDays": 90 },   // optional
      "reminders": { "unclaimedInvite": 5, "newBuild": true, "surveyNudge": 3, "endingSoon": 3 },
      "retention": { "declinedDays": 30, "afterCloseDays": 180, "acceptanceDays": 730 }
    },
    "salt-and-ash-arc": { "name": "Salt & Ash ARC", "type": "book", "status": "draft",
      "terms": { "file": "terms/arc.md", "version": "1" } }
  },
  "builds": {
    "hl-0.4-win": { "beta": "hollow-lantern", "label": "0.4 Windows", "source": "github",
                    "repo": "you/hollow-lantern-builds", "tag": "v0.4.0", "asset": "HollowLantern-0.4-win.zip",
                    "survey": "hl-0.4" },
    "hl-steam": { "beta": "hollow-lantern", "label": "Steam playtest", "source": "link",
                  "url": "https://store.steampowered.com/app/000000/" },
    "sa-epub": { "beta": "salt-and-ash-arc", "label": "EPUB", "source": "r2", "key": "arc/salt-and-ash.epub",
                 "mark": "ebooks/salt-and-ash.mark.json" }   // Should: splice manifest from prepare-ebook
  },
  "surveys": { "hl-0.4": { "questions": [ { "id": "fun", "type": "rating", "label": "How fun was 0.4?" } ] } },
  "email": { "dailyCap": 90, "monthlyCap": 2800 },
  "screenshots": { "store": "d1", "maxBytes": "400KB", "perBug": 2, "totalCap": "150MB" }
}
```

`wrangler.jsonc` vars: `PUBLIC_URL`, `MAIL_FROM`, `OWNER_EMAIL` (a verified Email Routing address). Secrets: `ADMIN_TOKEN`, `LINK_SECRET`, `SESSION_SECRET`, `IP_SALT`, `RESEND_API_KEY`, `TURNSTILE_SECRET_KEY`, optional `GITHUB_TOKEN` (fine-grained, *Contents: read* on the builds repository only), and optional `KEYS_URL` plus `KEYS_TOKEN`, or a `KEYS` service binding.

### Routes

| Route | Who | What |
|---|---|---|
| `GET /b/:beta` · `POST /b/:beta/apply` | anyone | Application form. `POST` always answers `200` with the same "thanks" page (or JSON). A closed or draft beta shows "not open", and that answer is the same for every visitor. |
| `GET /i/:token` · `POST /i/:token/claim` | invitee | Invite page (no state change), then the claim (terms, full name). Unknown, used, expired and revoked tokens all get one page: "This invite link doesn't work any more. If you were invited, sign in or ask for a new link." |
| `POST /signin` `{email, beta}` · `GET /s/:token` · `POST /s/:token` | tester | Always `202`. An active tester is emailed a 30-minute single-use sign-in link (claim-then-act, as invites); the `POST` sets the cookie. |
| `GET /t` · `/t/:beta` | tester (cookie) | Builds, surveys, bug form, terms, settings. |
| `GET /d/:build` | signed URL | Download (see "Downloads"). |
| `POST /t/:beta/survey/:id` · `POST /t/:beta/bugs` | tester | Feedback; bugs as `multipart/form-data` with screenshots. |
| `GET /t/me/export` · `POST /t/me/delete` · `POST /t/:beta/withdraw` · `POST /t/me/reminders` | tester | Privacy and settings. |
| `GET /tick` | anyone | Re-arms `Clock` if its alarm is missing. Returns no data. |
| `/api/*` | `ADMIN_TOKEN` | See "Admin API". |

**Session:** cookie `pb_s` = `tester_id.session_ver.exp.HMAC(SESSION_SECRET, …)`, set with `HttpOnly; Secure; SameSite=Lax; Path=/`, lasting 30 days. Each request does one D1 read (status, `session_ver`, terms version). State-changing `POST`s check `Origin` against `PUBLIC_URL` and need a per-session CSRF value in the form.

### Invites and claim-then-act

1. Approve (app action or API): the tester becomes `approved`, an `invites` row is created (`status = 'queued'`, holding the token hash), and so is a `deliveries` row, all in one D1 batch. The token itself exists only in the email: `Clock` makes it when it sends, stores its hash, and marks the invite `sent`. A re-send makes a new token, and the old hash stops matching.
2. `GET /i/<token>`: hash it and look it up. A valid invite shows the beta, the terms text and the version; anything else shows the uniform page.
3. `POST /i/<token>/claim` with `accept=1`, the full name, the CSRF value and the version shown: one D1 batch does the conditional claim `UPDATE … RETURNING`, then `testers.status = 'active'`, the `acceptances` row and an `events` row. **If the claim updates no rows, nothing else in the batch runs** (each statement is guarded by `WHERE EXISTS (claimed row)`), and the uniform page is shown. If the version shown is no longer current, the invite is not claimed and the page reloads with the new terms.
4. After the batch, the session cookie is set and, if the beta has `keys`, the key request runs in `waitUntil` (see "perchlight-keys").
5. A double-click, two tabs or a replayed `POST`: the second claim finds `status = 'claimed'`. If the browser already holds a session for that tester, it goes to `/t`; otherwise it gets the uniform page with a sign-in link.

### Downloads

1. Check the signature by recomputing it and comparing with `crypto.subtle.verify` (HMAC), then the expiry (15 minutes), then the tester's status and the build's available and expiry times, then the daily limit (30 downloads per tester per day, settable). All of these fail with one `403` page, "This download link has expired or isn't yours. Open your tester page for a fresh one", so the answer reveals nothing about which check failed.
2. Insert a `downloads` row with `result = 'started'`.
3. By source:
   - **`link`:** `302` to the URL. It was checked when set: `https:` only, no credentials, not this deployment's own host, not an IP literal in a private, loopback, link-local or CGNAT range, not `localhost` or `*.local`. These are hooks' rules; the Worker never fetches the URL, so this guards against mistakes and open-redirect abuse rather than SSRF. Leak note: the URL itself can be shared. If that matters, use a store's own tester system (TestFlight, Steam playtest, Play testing) behind the link, or `github`/`r2`.
   - **`github`:** `GET https://api.github.com/repos/{owner}/{repo}/releases/assets/{id}` with `Accept: application/octet-stream` and `redirect: "manual"`. GitHub "will either redirect the client to the location, or stream it directly if possible" ([GitHub release assets](https://docs.github.com/en/rest/releases/assets#get-a-release-asset)). On a `302`, the tester is sent to that `Location` (signed by GitHub and short-lived, so the file never passes through the Worker). On a `200`, the Worker streams the body, which costs no CPU beyond the pipe. Asset ids are resolved from `tag` and `asset` once and cached in D1. The host is fixed, so there's no SSRF surface.
   - **`r2`:** `FILES.get(key, {range})`, served with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, and a `206` for ranges.
4. Not every completed download can be seen (redirects end the Worker's view). The log records "link issued and used", and the dashboard says "downloads started".

### Leak tracing (deterrent only)

Said plainly in the README and on the invite page ("Your copy is linked to you"): **none of this stops a determined leaker.** It makes leaks traceable in the common cases and puts testers on notice.

| Layer | Works for | What it gives | Limits |
|---|---|---|---|
| Per-tester signed URLs + download log | all | who fetched which build, and when | a shared `link` URL or a re-uploaded file can't be traced |
| Per-tester perchlight-keys key | games and apps that check keys | a leaked build needs a key; a leaked key names the tester, and revoking it stops it working | only if your build checks keys; a cracked build gets past it |
| Reader code on a visible page (Should) | EPUB and PDF, served via `r2` or a streamed `github` asset | "Prepared for J. Smith · reader code 7F3K-Q2" on the copyright page | removed by editing the file; costs a streamed download (no redirect) |
| Hidden marker in the same splice (Should) | EPUB and PDF | the code repeated in an EPUB `<meta>` or PDF `/Info` field kept to a fixed length | removed by any re-export |

**How the splice stays cheap on Workers (Should):** `npm run prepare-ebook` runs once on your computer. It puts a fixed-length placeholder (`@@READER:XXXXXXXXXXXXXXXXXXXXXXXX@@`, padded) into one EPUB XHTML entry **stored uncompressed** (zip method 0), or into an uncompressed PDF content stream and the `/Info` dictionary. It then writes `*.mark.json` with the byte offsets of each placeholder and, for EPUB, the offsets of that entry's CRC-32 in its local header and central directory record. At download time the Worker streams the original and replaces bytes only at those known offsets: the reader text (same length, padded with spaces) and, for EPUB, the CRC-32 of the one small entry, computed over a few KB. There's no unzipping, parsing or recompressing, so CPU use is close to that of a plain pipe. Files above 50 MB aren't marked. The tool refuses DRM'd input, and EPUBs that are signed or encrypted (`META-INF/encryption.xml`). Mark a fixed-layout or signed PDF only if you accept that the signature breaks. **Measure CPU in the build**; if a 20 MB EPUB goes over Free's 10 ms, marking falls back to `link`-style download with the log only.

### Feedback and screenshots

- Survey and bug bodies are capped (whole request 32 KB without files; 900 KB with 2 screenshots). Text is stored as text and shown escaped. The desktop app shows it as plain text.
- **Screenshots:** the first bytes are checked (PNG `89 50 4E 47`, JPEG `FF D8 FF`, WebP `RIFF….WEBP`), at most 400 KB each, 2 per bug, 20 bugs per tester per day. With `store: "d1"` (default), each image is one `bug_images` row (a BLOB, well under D1's 2 MB row limit). A deployment-wide cap (`totalCap`, default 150 MB) leaves room in the 500 MB database. Over the cap, the bug is accepted without images, and both the tester and you are told. With `store: "r2"`, images go under `bugs/` in R2 and the cap is 1 GB. Images are served only through the admin API, as attachments with `nosniff` and `CSP: sandbox`, so an uploaded file can't run as a page.
- Metadata isn't stripped from images in v0.1 (that would be expensive on the CPU). The bug form says "Screenshots are sent as-is", and shrinking in the browser re-encodes them anyway, which drops EXIF.

### Email

- **Resend free plan: 100 emails a day, 3,000 a month** ([Resend pricing](https://resend.com/pricing), checked 2026-11-12). The defaults are `dailyCap: 90` and `monthlyCap: 2800`, counted in `Clock`'s SQLite, which leaves room for tests and for perchlight-keys if both share one Resend account. The config check warns when both deployments share an API key.
- **Priority order** when the cap is near: sign-in links, invites, new-build notices, reminders. Anything that doesn't fit waits for the next UTC day. The app shows "Queued: 40 invites, sending from 00:00 UTC", and `POST /api/betas/:id/approve` reports how many days a bulk approval will take ("150 invites: sent over 2 days").
- Each send is claimed first. The idempotency key is `beta-<delivery id>` (Resend keeps keys for 24 hours, as perchlight-keys notes). An `unknown` result is retried with the same key, which is safe. `throttled` (`daily_quota_exceeded`, `rate_limit_exceeded`) moves the delivery to the next day.
- Every tester email has a plain-text part, the beta name, and how to stop reminders. These emails are transactional (to people who applied), not marketing. The README still points to CAN-SPAM and GDPR, as perchlight-list does.
- Notices to you go by `send_email` to `OWNER_EMAIL`, free, and grouped into one email at most every 30 minutes, so 50 applications don't mean 50 emails.

### `Clock` (reminders without cron)

One run (one alarm): set the next alarm first (5 minutes ahead, or sooner if a queued sign-in link is waiting), then:

1. Read the app's pending actions (`action_requested` on `testers`, `invites`, `bugs`) and apply them in one D1 batch.
2. Read the deliveries that are due and send as many as both the cap and the subrequest budget allow (45 of 50 per invocation ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)): 3 for D1, 1 for the keys call, the rest for email, so at most 30 emails a run).
3. Reminders: one indexed query per kind, and an `INSERT … ON CONFLICT DO NOTHING` into `reminders_sent (tester, kind, subject)` before queuing, so each reminder is sent once.
4. Expire invites past `expires_at`, and run retention (up to 500 deletes a run, plus R2 deletes when R2 is used).
5. Write hot state to SQLite (one row).

The Worker calls `clock.wake()` after an action that creates urgent email (a sign-in link, a manual invite). Lazy fallback: any request, and `GET /tick`, re-arm the alarm if the last run is more than 10 minutes old.

### perchlight-keys

- **Issue:** `POST {KEYS}/api/licenses` with `{product, edition, email, source: "import", source_ref: "beta:<beta>:<tester id>", expires_days, send_email: true, notes: "perchlight-beta"}`. perchlight-keys has `UNIQUE (source, source_ref)` on licences, so a retried call can't create a second key. perchlight-keys emails the key from its own Resend quota (counted in the shared-key warning above), so beta never sees or stores the key. Beta stores only the returned licence id.
- **Revoke:** perchlight-keys' admin revoke for that licence id, with the reason `beta access revoked`.
- **Transport:** a service binding (`KEYS`) when both run on the same account (a plain same-zone `fetch()` to another Worker fails without one ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/))), or `KEYS_URL` checked by the SSRF rules. A failed call is retried by `Clock` with backoff and shown in the app as "key pending". The tester can claim their invite before the key exists.
- **Privilege:** perchlight-keys has only `ADMIN_TOKEN` today, so beta would hold full admin rights there (decision 3).

### perchlight-list

There's no API call and no shared data. You write an announcement in perchlight-list (desktop app) linking to `https://<beta host>/b/<beta>?src=list`. Applications record `src = list`, and the dashboard shows applications and approvals by source. Unsubscribing from the list doesn't touch the beta, and the reverse is also true; the README says so.

### Security

- **Constant-time compares** for the admin token, link and session HMACs (`crypto.subtle.verify`) and Turnstile. Tokens (invites, sign-in links) are looked up by SHA-256 hash, so no secret is compared byte by byte.
- **Enumeration:** apply, sign-in, invite and download failures give one answer each (same status, body length class and headers), and side effects run in `waitUntil`, so a response takes the same time with or without them.
- **Rate limits** (D1 `rate` rows; per IP hash unless noted): apply 5 an hour; sign-in 1 per 10 minutes and 5 a day per email, plus 20 an hour per IP; claim 10 an hour; bugs 20 a day and surveys 50 a day per tester; downloads 30 a day per tester; a global cap of 500 applications a day per beta (protects D1 from a Turnstile bypass). The optional Workers rate-limiting binding is commented out, as in perchlight-hooks.
- **Input limits:** name 100, email 254, answers as listed, 20 questions, JSON body 32 KB, multipart 900 KB, the path and query 2 KB. Larger requests are refused before the body is read.
- **SSRF:** the only owner-configured URLs the Worker fetches are `KEYS_URL` and the optional notification webhooks. Both are checked with hooks' rules when set and before each send, redirects aren't followed, and a service binding is preferred. `link` URLs are redirect targets only (checked as above). The GitHub and Resend hosts are fixed.
- **Output:** every page sets `Content-Security-Policy` (no inline script except the Turnstile and image-resize script by hash), `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer` (so a token in a URL isn't leaked through `Referer`).
- **Secrets** are never stored in D1 or put in email bodies, except the one invite or sign-in link meant for that person.

### Admin API

`Authorization: Bearer <ADMIN_TOKEN>`.

| Endpoint | What it does |
|---|---|
| `GET /api/betas` · `POST /api/betas/:id/close` | Betas, config errors, counts. |
| `GET /api/applications?beta=&status=` · `POST /api/applications/decide {ids, action}` | List; approve, decline, waitlist or block in bulk (reports the email queue time). |
| `POST /api/invites` · `POST /api/invites/:id/resend` · `POST /api/invites/:id/revoke` | Manual invites. |
| `GET /api/testers/:id` · `POST /api/testers/:id/revoke` · `GET /api/testers/:id/export` · `DELETE /api/testers/:id` | One tester's record, revoke, privacy. |
| `GET/POST/PATCH /api/builds` · `POST /api/builds/:id/resolve` | Runtime builds; re-resolve a GitHub asset id. |
| `GET /api/downloads?beta=&build=&tester=` · `GET /api/feedback?survey=` · `GET /api/bugs?beta=&status=` · `GET /api/bugs/:id/images/:n` | Activity, responses, bugs, screenshots (as attachments). |
| `GET /api/dashboard?beta=` · `GET /api/acceptances?beta=` | Dashboard; the acceptance log. |
| `GET /api/deliveries?status=` · `POST /api/deliveries/:id/retry` · `POST /api/test-email` | Email queue and failures. |
| `GET /api/footprint` · `POST /api/housekeeping` | Daily counts; run `Clock` now. |

### Data model (D1)

- `betas`: `id`, `name`, `type`, `status`, `terms_version`, `terms_sha256`, `max_testers`, `ends_at`, `closed_at`, `config_error`.
- `testers`: `id` (random), `beta_id`, `email`, `email_hmac` (unique per beta, used for lookups), `name`, `answers` (JSON), `src`, `status` (`applied` | `waitlisted` | `approved` | `invited` | `active` | `declined` | `blocked` | `revoked` | `withdrawn`), `reader_code` (8 Crockford base32 characters, unique), `groups`, `session_ver`, `terms_accepted_version`, `license_id`, `key_status`, `reminders_off`, `applied_at`, `decided_at`, `last_seen_day`, `action_requested`, `delete_after`. Indexes `(beta_id, status)`, `(email_hmac)`.
- `invites`: `id`, `tester_id`, `token_hash` (unique), `status` (`queued` | `sent` | `claimed` | `expired` | `revoked`), `created_at`, `sent_at`, `expires_at`, `claimed_at`.
- `signins`: `token_hash`, `tester_id`, `expires_at`, `used_at` (deleted after 1 day).
- `acceptances`: `id`, `tester_id` (null after deletion), `email_hmac`, `beta_id`, `version`, `text_sha256`, `full_name` (cleared on deletion), `how`, `accepted_at`. The app can only add to it.
- `builds`: `id`, `beta_id`, `label`, `platform`, `source`, `target` (URL, `repo/tag/asset`, or R2 key), `asset_id`, `mark_manifest`, `groups`, `survey_id`, `available_at`, `expires_at`, `origin` (`config` | `api`).
- `downloads`: `id`, `tester_id`, `build_id`, `at`, `source`, `result` (`started` | `refused_limit` | `refused_revoked` | `upstream_error`), `colo`, `marked`.
- `responses`: `(survey_id, tester_id)` primary key, `build_id`, `answers`, `submitted_at`, `updated_at`.
- `bugs`: `id`, `tester_id`, `build_id`, `title`, `body`, `severity`, `platform`, `status`, `action_requested`, `created_at`. `bug_images`: `bug_id`, `n`, `mime`, `size`, `data` (BLOB) or `r2_key`.
- `events`: `id`, `tester_id`, `beta_id`, `kind`, `at`, `detail` (small JSON). Feeds the dashboard's activity column; kept 180 days.
- `deliveries`: as perchlight-forms, plus `priority` and `not_before_day`. Kinds `invite`, `signin`, `new_build`, `reminder_*`, `key_issue`, `key_revoke`.
- `rate`, `state` (footprint per day, schema version).
- **`Clock` SQLite:** `run` (one row), `email_counts` (day and month), `reminders_sent`, `claims`.

**Retention** (applied by `Clock`): declined and blocked applicants deleted after `declinedDays` (30), keeping only an `email_hmac` for blocked ones; sign-in rows after 1 day; events and downloads after 180 days; after a beta closes, everything about its testers after `afterCloseDays` (180), except `acceptances`, which are pseudonymised (name cleared, `email_hmac` kept) and removed after `acceptanceDays` (730). **Delete on request** does the same at once: the tester's rows, images, responses, bugs (or, if you choose `keepBugs: true`, bugs with the tester id cleared) and deliveries go, plus a keys revoke if a key was issued. The only thing kept is the pseudonymised acceptance (decision 4). The export includes everything above, including the acceptance rows.

### Desktop app screens (`perchlight/perchlight.json`)

- **Applications** (`testers` where status is `applied` or `waitlisted`): name, email, source, applied, answers (detail pane). Actions *Approve* / *Decline* / *Waitlist* / *Block* (set `action_requested`).
- **Testers** (status `invited` or above): reader code, status, last seen, downloads, feedback count, key status. *Revoke*, *Re-send invite*.
- **Builds** (`builds`): label, source, available, downloads (a view joined over `downloads`).
- **Downloads** (`downloads`, newest first), **Feedback** (`responses`), **Bugs** (`bugs`, with status editable; screenshots through the admin API, as perchlight-forms' attachments), **Acceptances** (read-only), **Email queue** (`deliveries`, *Try again*).
- Note: app actions take effect on `Clock`'s next run (5 minutes at most), since the app doesn't wake the Worker.

### Footprint

Free limits: Workers 100,000 requests a day, 10 ms CPU, 50 subrequests per invocation ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)); D1 100,000 rows written and 5,000,000 read a day, 500 MB per database, 2 MB per row ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)); Durable Objects 100,000 requests (alarms included), 100,000 rows written and 13,000 GB-s a day ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)); R2 10 GB-month, 1M Class A and 10M Class B operations a month, free egress ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)); Resend 100 emails a day, 3,000 a month ([Resend pricing](https://resend.com/pricing)); Turnstile unlimited ([Turnstile plans](https://developers.cloudflare.com/turnstile/plans/)). As in perchlight-hooks, each insert or delete is assumed to also write one row per index.

**Example:** one game beta at its busiest week. 25 applications a day, 100 active testers each opening the tester page 3 times a day, 40 downloads, 30 survey responses, 10 bugs with 2 screenshots of about 250 KB, and 60 tester emails.

| | Limit (Free) | Example | Share |
|---|---|---|---|
| Worker requests (pages ~450, apply 25, downloads 40, feedback 40, sign-in ~30, ticks) | 100,000/day | ~650 | 0.7% |
| D1 rows written (applications ~100, sessions `last_seen_day` ≤100, events ~400, downloads ~80, feedback ~150, rate ~300, deliveries ~180, retention ~200) | 100,000/day | ~1,500 | 1.5% |
| D1 rows read (session check per request, dashboard via the app) | 5,000,000/day | ~20,000 | 0.4% |
| D1 storage (screenshots 5 MB/day, capped at 150 MB; text a few MB) | 500 MB | ≤ 160 MB | ≤ 32% |
| `Clock` runs (every 5 min, plus wakes) | DO 100,000 requests/day | ~320 | 0.3% |
| DO rows written (hot state, counts, claims) | 100,000/day | ~800 | 0.8% |
| Subrequests, worst invocation (`Clock`: 3 D1 + 1 keys + 30 email) | 50 | 34 | 68% of one run |
| Tester emails | Resend 100/day, 3,000/month | 60 (cap 90) | 60% of daily |
| R2 (optional, a 300 MB build × 100 testers) | 10 GB-month, 10M Class B | 0.3 GB, ~100 reads | ~3% |

- **Email is the binding limit.** Inviting 150 people takes 2 days at the default cap; a monthly 2,800 cap covers about 3 large invite waves. Everything else uses less than 2% of its limit.
- **Screenshots are the storage risk.** Without R2, the 150 MB cap is reached after about a month at 10 bugs a day, unless retention or deletions free space; the app shows how full it is.
- **CPU:** HMAC, SHA-256 and siteverify use WebCrypto or wait on the network. The streamed splice touches only bytes at fixed offsets; measure it in the build.
- **What it costs you:** nothing inside the free plans. R2 is optional because it asks for a payment method before it can be turned on (see "Couldn't verify").

## Edge cases

- **An invite opened by a mail scanner:** `GET` changes nothing; only the `POST` claims.
- **An invite claimed twice at once:** the conditional `UPDATE` lets exactly one through; the other gets the uniform page, or the tester page if it already has that tester's session.
- **An invite forwarded to someone else:** whoever claims it first becomes that tester (claiming is what proves possession). The acceptance logs the name they type. The owner can revoke and re-invite. The README says invites are personal.
- **Terms change between showing the page and claiming:** the version shown doesn't match, nothing is claimed, and the page reloads with the new text.
- **The same person applies to two betas:** separate tester rows (the `email_hmac` is unique per beta), and the export covers both.
- **Revoked while downloading:** a redirect already issued finishes; new URLs are refused; an R2 stream that has started finishes.
- **A GitHub token expired or the asset was deleted:** the download is logged `upstream_error`, the tester sees "This build is temporarily unavailable", and you get one notice a day per build.
- **A GitHub `302` URL shared:** it's short-lived and was issued after a logged, per-tester download. It traces to that tester.
- **Resend quota exhausted early** (shared with perchlight-keys or tests): `throttled` moves deliveries to tomorrow, and sign-in links are tried first. The tester page says "If your email hasn't arrived, it will come after 00:00 UTC."
- **D1 out of writes:** apply answers the uniform "thanks" only if the row was stored; otherwise `503` ("Please try again later"). Downloads still work for testers with a session, with the log write skipped and counted in isolate memory. `Clock` keeps email counts in its own SQLite.
- **The `Clock` alarm stops:** lazy re-arm from requests and `/tick`; reminders run late, never twice (`reminders_sent`).
- **The alarm runs twice:** delivery claims and `reminders_sent` stop duplicate sends.
- **perchlight-keys down when a key is due:** `key_status = 'pending'`, retried by `Clock` (1, 5, 30 min, 2 h, 12 h), and shown in the app.
- **A tester deletes their data, then a delivery for them is due:** deliveries are deleted with the tester; a delivery already claimed finds no tester and is dropped.
- **maxTesters reached:** further approvals go on the waitlist with a note; the application page keeps taking applications for the waitlist.
- **A beta closed with invites open:** they're revoked and the uniform page shows.
- **Clock skew:** all expiries are checked by the Worker's clock, in UTC.

## Decisions

All nine open questions were decided on 2026-11-12, each as recommended.

1. **Default download source — decided:** `link` is the documented default (it works for store-based betas: TestFlight, Steam playtest, Play testing, itch.io restricted pages), with `github` (private repository) recommended for game and ebook files and set up by the Deploy button's guide. R2 stays optional because of the payment method.
2. **"Application received" email — decided:** off by default. It uses scarce Resend quota and turns the form into a way to send mail to other people's addresses; the uniform page says what happens next.
3. **Privilege in perchlight-keys — decided:** add a scoped `ISSUE_TOKEN` to perchlight-keys (issue and revoke only, `source = "import"` with `source_ref` starting `beta:`), a small change there and a separate follow-up; until then, beta requires a service binding and the config check warns.
4. **What survives a tester's delete request — decided:** only a pseudonymised acceptance (email HMAC, version, text hash, time), kept 730 days because the NDA record protects both sides; settable to 0. The README advises checking local law.
5. **Screenshots without R2 — decided:** 2 per bug, 400 KB each, shrunk in the browser, with a 150 MB cap. Lower the cap if the database also holds a long-running beta.
6. **Sessions — decided:** a signed cookie plus `session_ver` (one read per request, no writes), with `last_seen_day` written at most once a day.
7. **`Clock` interval — decided:** 5 minutes (about 290 DO requests a day). A 1-minute grid would cost about 1,450 a day, still small, if users ask for it.
8. **EPUB and PDF marking in v0.1 — decided:** Should, built only after a CPU measurement on a real 20 MB EPUB on Free. If it passes, ship it for `r2` and streamed `github`; if not, document "log only" for ebooks. (Not built in v0.1: the measurement hasn't been made; see TECH_DEBT.md.)
9. **Several betas per deployment — decided:** yes, up to 10, sharing one email cap; an author running ARCs for several books shouldn't need several deployments.

## Acceptance criteria

- Applying twice with the same email, applying to a closed beta's waitlist, and applying from a blocked address all return byte-identical responses (status, headers and body). One tester row exists afterwards, with the latest answers.
- An application without a valid Turnstile token is not stored; the same request with one is.
- Approving in the desktop app sends one invite within 5 minutes. Opening the invite link with `GET` ten times changes nothing. One `POST` claim succeeds, a second gives the uniform page, and an expired or revoked link gives the same page.
- After a claim, `acceptances` holds the tester, the version, the SHA-256 of the exact terms text shown, the typed name and the time. Changing the terms version forces re-acceptance before the next download.
- A download URL works for 15 minutes for its tester. It fails with one uniform `403` after expiry, with any altered parameter, after the tester is revoked, and past the daily limit. Every attempt is in `downloads`.
- With `source: "github"`, the tester is redirected to GitHub's URL and the Worker's response contains no file bytes; with `source: "link"`, it redirects to the configured URL. A configured `link` of `http://127.0.0.1/` or the deployment's own host is refused when set.
- A bug report with two 400 KB screenshots is stored. A third image, a 500 KB image, or an HTML file renamed `.png` is refused with a clear message. Over the 150 MB cap, the bug is stored without images and says so.
- Revoking a tester makes their next request redirect to sign-in, and their sign-in requests send nothing. A key issued through perchlight-keys is revoked there (checked against a local perchlight-keys in the integration test).
- Approving 150 testers with `dailyCap: 90` sends 90 invites on day one and 60 on day two, sign-in links take priority over queued invites, and no address receives a duplicate if the alarm runs twice.
- A reminder (unclaimed invite after 5 days) is sent once, and not to a tester who turned reminders off or has since claimed the invite.
- `GET /t/me/export` returns every row tied to the tester. `POST /t/me/delete` removes them, leaving only the pseudonymised acceptance.
- `GET /api/footprint` after a simulated busy day of the example shows under 2,000 D1 rows written and under 400 DO requests.

## Testing

- **Unit:** signed URL and cookie HMACs (expiry, tampering, constant-time path); uniform response bytes; question validation and limits; screenshot checks by first bytes; email priority and cap arithmetic across the day and month boundary; reminder rules; retention dates; SSRF and `link` URL checks (hooks' list); the EPUB and PDF splice against fixtures (CRC-32 correct, the file opens in a validator, length unchanged).
- **Integration** (`@cloudflare/vitest-pool-workers`, local D1, the `Clock` DO, fake Resend, fake GitHub API and a local perchlight-keys Worker as a service binding): apply → approve via `action_requested` → `Clock` run → invite → claim race → download (all three sources; R2 with Miniflare's local R2) → survey → bug with images → revoke → export → delete; the alarm run twice; D1 write failures; the quota rolling over to the next day.
- **Locally with `wrangler dev`** (free): the full tester flow in a browser, Turnstile with Cloudflare's test keys, a real private GitHub repository release with a fine-grained token (free), real Resend sends to your own address on the free plan, and a marked EPUB opened in Calibre and a marked PDF opened in a browser.
- **Not tested** (costs money, or needs a card-backed account):
  - R2 on a real account (it asks for a payment method; tested only against Miniflare's local R2);
  - Resend above the free plan, or sending from a paid plan's dedicated IPs;
  - TestFlight, Steam playtest and Google Play testing links (beta only redirects to them; their programmes need paid developer accounts);
  - Workers Paid (higher CPU for marking large ebooks): the design stays inside Free.

## Couldn't verify (2026-11-12)

- **Whether R2 needs a card:** Cloudflare's R2 pricing page doesn't say so. Third-party guides say a payment method is asked for before the first bucket, and perchlight-forms' and perchlight-updates' SDDs record the same. Treated as "yes" here, so R2 is optional.
- Resend's API rate limit (its pricing page says only that it's the same on every plan; perchlight-keys' code comment says 10 requests a second per team) and whether the free plan needs a card.
- How long GitHub's redirected asset URL lasts, the maximum release asset size, which token permission private-repository assets need, and when GitHub streams instead of redirecting (the docs say "if possible").
- Whether D1 index updates count as extra rows written; whether DO alarms also count toward the Worker's 100,000 requests (both assumed, as perchlight-hooks).
- Whether the Workers rate-limiting binding is available on Free.
- The CPU cost of the streamed EPUB/PDF splice on Free (10 ms); any limit on streamed response size.
- perchlight-keys: what `POST /api/licenses` returns for a duplicate `(source, source_ref)`, and the exact revoke route (the `UNIQUE` constraint was checked in `migrations/0001_init.sql`; the API shapes weren't).
- `send_email` daily limits to verified addresses.
- Prices of hosted beta and ARC services (BetaFamily, TestFairy, BookSirens, NetGalley, BookFunnel); not checked, so no comparison is made.

## Sources

- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- Durable Objects pricing and limits: https://developers.cloudflare.com/durable-objects/platform/pricing/ · https://developers.cloudflare.com/durable-objects/platform/limits/
- R2 pricing (10 GB-month, 1M Class A, 10M Class B, free egress, Standard storage only): https://developers.cloudflare.com/r2/pricing/
- Turnstile plans (free, unlimited, 20 widgets): https://developers.cloudflare.com/turnstile/plans/
- Resend pricing (free: 100/day, 3,000/month): https://resend.com/pricing
- GitHub release assets: https://docs.github.com/en/rest/releases/assets#get-a-release-asset
- Family: `../perchlight-hooks/docs/SDD.md` (Scheduler, SSRF), `../perchlight-keys/docs/SDD.md` and `src/lib/mail/` (Resend, enumeration-safe resend, `action_requested`), `../perchlight-forms/docs/SDD.md` (deliveries, signed file links, Turnstile, R2 note), `../perchlight-list/README.md` (senders, announcements, `source`).
