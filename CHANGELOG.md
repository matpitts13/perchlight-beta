# Changelog

## v0.1.0

The first release of perchlight-beta: a free, self-hosted portal for private betas and advance-reader copies, on your own Cloudflare account (Workers + D1 + one Durable Object).

**Set up** with `npm run deploy`. See the [README](https://github.com/matpitts13/perchlight-beta#readme).

### What's in it

- **Applications** with your own screening questions and a Turnstile bot check. Everyone gets the same answer, so nobody can find out who applied. You approve applicants in the [Perchlight](https://github.com/matpitts13/perchlight) desktop app.
- **Invites that work once:** they expire after 14 days, and only a button press claims them, so email scanners opening the link change nothing.
- **NDA records:** terms version, a hash of the exact text, the typed name and the time.
- **Personal download links** that expire after 15 minutes, with every download logged. Files stay on your own host or a private GitHub repo by default, and R2 is optional.
- **Per-tester license keys** for game builds through [perchlight-keys](https://github.com/matpitts13/perchlight-keys), as a leak-tracing deterrent.
- **Feedback, surveys and bug reports** with up to 2 screenshots each (shrunk in the browser).
- **Revoke access at any time;** testers can export or delete their own data.
- **Email through Resend,** capped below the free 100 a day, with sign-in links sent first and the rest held until the next day.
- **Reminders and cleanup on a Durable Object alarm** (no cron trigger).
- **Up to 10 betas per deployment.**

### Tested, and not tested

111 automated tests run against a real local D1, Durable Object and R2 binding.

Not tested: deploying on a real account, the perchlight-keys link against a real deployment, real Resend and Turnstile, GitHub downloads, the alarm firing on its own in production, and R2 on a real account (it may need a card on file).
