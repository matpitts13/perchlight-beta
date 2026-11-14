# Tech debt

- **perchlight-keys: scoped issue/revoke token (follow-up in perchlight-keys).** SDD decision 3. perchlight-keys has only a full `ADMIN_TOKEN`; beta therefore requires a `KEYS` service binding and the config check warns that `KEYS_TOKEN` grants full admin there. Planned: an `ISSUE_TOKEN` in perchlight-keys limited to `POST /api/licenses` with `source: "import"` and `source_ref` starting `beta:`, and `POST /api/licenses/:id/revoke` for those licences. Beta's side (`src/lib/keys.js`) is coded against the documented interface and only tested against a stubbed binding; once the token exists, run the flow against a local perchlight-keys Worker (what a duplicate `(source, source_ref)` returns, the revoke route) and drop the `KEYS_TOKEN_SCOPED` switch if the binding stays required. Found while building v0.1 (2026-11-13).
- **EPUB/PDF reader-code marking not built** (SDD "Should", decision 8). Needs `npm run prepare-ebook` and a CPU measurement of the streamed splice on a real 20 MB EPUB on Workers Free first. Until then ebooks are "log only".
- **Other SDD "Should" items not built in v0.1:** the notification webhook (perchlight-status' `notify.js`), the optional "application received" email, CSV export of applications/feedback/bugs (formula characters escaped). `POST /api/betas/:id/close` is built.
- **Desktop manifest has no row filters.** The Perchlight manifest schema used by the family has no `filter`, so the Applications and Testers screens both list every tester. If the schema gains a filter, add `status IN (applied, waitlisted)` and `status IN (approved, …)`.

## LOW findings from the v0.1 review (2026-11-13), parked

- **Invalid-signature download attempts write a row** (`src/routes/download.js`). Anyone holding a tester id (it's in their own links) can add `refused_invalid` rows, limited only by 60 a minute per isolate. Fix: don't log `refused_invalid`, or count it in a per-tester D1 bucket.
- **A repeat application overwrites a pending applicant's answers** (`src/routes/apply.js`), and each repeat adds an `applied` event (inflating owner notices). Fix: keep the first answers or require the invite email to confirm; add the event only for new rows.
- **Sign-in rate buckets are spent before the tester lookup** (`src/routes/signin.js`): someone who passes Turnstile can use up a known tester's 5 sign-ins a day. Fix: also a per-beta daily bucket; consider counting only for real testers (keeping the timing uniform).
- **Applicant names aren't stripped of control characters** before the plain-text "Hi {name}" line (`src/lib/emails.js`, `src/routes/apply.js`). Fix: strip CR/LF and other controls on apply.
- **One perchlight-keys call per run** (`src/clock.js` keysWork): 150 key issues take ~12.5 hours. Fix: signal leftover/wake while key deliveries are pending (within the budget).
- **A GitHub tag containing `/` is mis-split** (`src/lib/github.js` splitTarget). Fix: reject `/` in tags, or store repo/tag/asset separately.
- **Retention deletes 100 rows per table per hour** (`src/clock.js`): `rate`, `events` and `downloads` can outgrow it at sustained high volume. Fix: loop within the budget.
- **Survey POSTs don't re-check terms acceptance, build availability or groups** (`src/routes/tester.js`); they do check the build belongs to the beta.
- **No attempt limit on bad admin tokens** (`src/routes/admin.js`). Fine for a long random token; README asks for 16+ random characters.
- **`announced = 1` is set for every build** (`src/clock.js` reminders), including ones with a config error or in a beta with newBuild off; a build fixed later is never announced.
- **D1 BLOB binding of a `Uint8Array`** is verified only in Miniflare (`src/routes/tester.js`). Confirm on real D1.
- **D1 statements per invocation aren't counted separately** from subrequests (batches count as one). The config sync is chunked to 20 statements a run and decisions chunk at 90 ids; a very large `decide` of 200 app actions in one run can still mean many statements.

## From the focused re-review of f8800b7 (all LOW)

- `src/clock.js` (step error handling): any failing step applies the 5-60 min back-off to the whole run, so a persistently failing non-critical step (e.g. housekeeping) slows email draining to one run per hour and clears `leftover`. Sign-in/approve `wake()` still override it. Fix: keep a separate failure counter for non-email steps.
- `src/lib/config.js` (`dailyCap + signinReserve` check): over 100 only warns; it should clamp or reject.
- Not covered by the re-review: the `testers.js` approval-order change.
