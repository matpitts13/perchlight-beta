-- perchlight-beta v0.1 (docs/SDD.md, "Data model"). Times are Unix
-- milliseconds (UTC), as perchlight-keys. No IP address is stored anywhere.

CREATE TABLE betas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,              -- draft | open | closed (closed_at set = closed)
  terms_version TEXT,
  terms_sha256 TEXT,
  max_testers INTEGER,
  ends_at INTEGER,
  closed_at INTEGER,
  config_error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE testers (
  id TEXT PRIMARY KEY,
  beta_id TEXT NOT NULL,
  email TEXT NOT NULL,               -- '' once a blocked applicant's details are cleared
  email_hmac TEXT NOT NULL,          -- HMAC(LINK_SECRET, email): lookups, unique per beta
  name TEXT,
  answers TEXT,                      -- JSON
  src TEXT,
  status TEXT NOT NULL,              -- applied | waitlisted | approved | invited | active | declined | blocked | revoked | withdrawn
  reader_code TEXT NOT NULL UNIQUE,
  groups TEXT,                       -- comma-separated, e.g. "steam-deck"
  session_ver INTEGER NOT NULL DEFAULT 1,
  terms_accepted_version TEXT,
  license_id TEXT,
  key_status TEXT,                   -- pending | issued | failed | revoked
  reminders_off INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  applied_at INTEGER,
  decided_at INTEGER,
  activated_at INTEGER,
  last_seen_day TEXT,
  action_requested TEXT,             -- desktop app: approve | decline | waitlist | block | revoke | resend_invite
  delete_after INTEGER,
  UNIQUE (beta_id, email_hmac)
);
CREATE INDEX testers_beta_status ON testers (beta_id, status);
CREATE INDEX testers_email ON testers (email_hmac);
CREATE INDEX testers_action ON testers (action_requested) WHERE action_requested IS NOT NULL;

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  tester_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,   -- SHA-256 of the token; the token itself is only in the email
  status TEXT NOT NULL,              -- queued | sent | claimed | expired | revoked
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  expires_at INTEGER,
  claimed_at INTEGER,
  claim_id TEXT,                     -- random, set by the one claim that succeeded (guards the rest of its batch)
  reminded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX invites_tester ON invites (tester_id, status);
CREATE INDEX invites_status ON invites (status, expires_at);

CREATE TABLE signins (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  tester_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX signins_tester ON signins (tester_id);

-- The NDA / terms log. Append-only: only the pseudonymisation on a delete
-- request (tester_id and full_name cleared) may change a row.
CREATE TABLE acceptances (
  id TEXT PRIMARY KEY,
  tester_id TEXT,                    -- NULL after deletion
  email_hmac TEXT NOT NULL,
  beta_id TEXT NOT NULL,
  version TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  full_name TEXT,                    -- NULL after deletion
  how TEXT NOT NULL,                 -- invite | re-accept
  accepted_at INTEGER NOT NULL,
  delete_after INTEGER               -- set when pseudonymised
);
CREATE INDEX acceptances_tester ON acceptances (tester_id);
CREATE INDEX acceptances_beta ON acceptances (beta_id, accepted_at);
CREATE TRIGGER acceptances_append_only BEFORE UPDATE OF id, email_hmac, beta_id, version, text_sha256, how, accepted_at ON acceptances
BEGIN SELECT RAISE(ABORT, 'acceptances are append-only'); END;
CREATE TRIGGER acceptances_no_renaming BEFORE UPDATE OF tester_id, full_name ON acceptances
WHEN NEW.tester_id IS NOT NULL OR NEW.full_name IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'acceptances can only be pseudonymised'); END;

CREATE TABLE builds (
  id TEXT PRIMARY KEY,
  beta_id TEXT NOT NULL,
  label TEXT NOT NULL,
  platform TEXT,
  notes TEXT,
  source TEXT NOT NULL,              -- link | github | r2
  target TEXT NOT NULL,              -- URL, owner/repo/tag/asset, or R2 key
  asset_id INTEGER,                  -- GitHub release asset id, resolved once
  mark_manifest TEXT,
  groups TEXT,                       -- comma-separated; NULL = everyone
  survey_id TEXT,
  available_at INTEGER NOT NULL,
  expires_at INTEGER,
  origin TEXT NOT NULL,              -- config | api
  announced INTEGER NOT NULL DEFAULT 0,
  config_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX builds_beta ON builds (beta_id);

CREATE TABLE downloads (
  id TEXT PRIMARY KEY,
  tester_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  source TEXT,
  result TEXT NOT NULL,              -- started | refused_invalid | refused_limit | refused_revoked | refused_terms | refused_unavailable | upstream_error
  colo TEXT,
  marked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX downloads_tester ON downloads (tester_id, at);
CREATE INDEX downloads_build ON downloads (build_id, at);
CREATE INDEX downloads_at ON downloads (at);

CREATE TABLE responses (
  survey_id TEXT NOT NULL,
  tester_id TEXT NOT NULL,
  build_id TEXT,
  beta_id TEXT NOT NULL,
  answers TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (survey_id, tester_id)
);
CREATE INDEX responses_tester ON responses (tester_id);

CREATE TABLE bugs (
  id TEXT PRIMARY KEY,
  tester_id TEXT,                    -- NULL if kept after the tester's deletion (keepBugs)
  beta_id TEXT NOT NULL,
  build_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  severity TEXT NOT NULL,            -- low | medium | high | critical
  platform TEXT,
  status TEXT NOT NULL DEFAULT 'new',-- new | triaged | fixed | wontfix | duplicate
  images INTEGER NOT NULL DEFAULT 0,
  images_note TEXT,
  action_requested TEXT,             -- desktop app: new | triaged | fixed | wontfix | duplicate
  created_at INTEGER NOT NULL
);
CREATE INDEX bugs_beta ON bugs (beta_id, status);
CREATE INDEX bugs_tester ON bugs (tester_id, created_at);
CREATE INDEX bugs_action ON bugs (action_requested) WHERE action_requested IS NOT NULL;

CREATE TABLE bug_images (
  bug_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB,
  r2_key TEXT,
  PRIMARY KEY (bug_id, n)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  tester_id TEXT,
  beta_id TEXT,
  kind TEXT NOT NULL,                -- applied | approved | claimed | revoked | withdrawn | bug | survey | upstream_error | ...
  at INTEGER NOT NULL,
  detail TEXT
);
CREATE INDEX events_at ON events (at);
CREATE INDEX events_tester ON events (tester_id);

-- Tester email, sent only by Clock. Claimed (status 'sending') before each send.
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                -- signin | invite | new_build | reminder_invite | reminder_survey | reminder_ending | key_issue | key_revoke
  tester_id TEXT,
  beta_id TEXT,
  ref TEXT,                          -- invite id, signin id, build id, survey id or licence id
  dedupe TEXT NOT NULL UNIQUE,       -- one per email or reminder occurrence
  priority INTEGER NOT NULL,         -- 0 sign-in, 1 invite, 2 new build, 3 reminder, 9 keys
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sending | retry | sent | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  not_before_day TEXT,               -- YYYY-MM-DD: waiting for the next day's email cap
  claimed_at INTEGER,
  claim_id TEXT,                     -- random, set by the one claim that succeeded (guards the rest of its batch)
  last_error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  action_requested TEXT              -- desktop app: retry
);
CREATE INDEX deliveries_due ON deliveries (status, priority, next_at);
CREATE INDEX deliveries_tester ON deliveries (tester_id);
CREATE INDEX deliveries_action ON deliveries (action_requested) WHERE action_requested IS NOT NULL;

CREATE TABLE rate (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX rate_expires ON rate (expires_at);

CREATE TABLE state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
INSERT INTO state (k, v) VALUES ('schema_version', '1');
