PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- One LinkedIn login. One browser profile directory. One egress IP if you use a proxy.
CREATE TABLE IF NOT EXISTS accounts (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  profile_dir  TEXT NOT NULL,
  proxy        TEXT,
  public_id    TEXT,
  status       TEXT NOT NULL DEFAULT 'unknown',   -- unknown | ok | logged_out | checkpoint
  last_seen_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'paused',      -- draft | running | paused | done
  config     TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, name)
);

-- The workflow. Authored top-to-bottom; executed bottom-to-top (see docs/ARCHITECTURE.md §2).
CREATE TABLE IF NOT EXISTS steps (
  id          INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  action      TEXT NOT NULL,
  params      TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (campaign_id, position)
);

-- profile_url is normalized (https://www.linkedin.com/in/<public-id>) and is the
-- dedup key across every table, forever.
CREATE TABLE IF NOT EXISTS leads (
  id           INTEGER PRIMARY KEY,
  profile_url  TEXT NOT NULL UNIQUE,
  public_id    TEXT,
  member_urn   TEXT,
  full_name    TEXT,
  first_name   TEXT,
  last_name    TEXT,
  headline     TEXT,
  company      TEXT,
  location     TEXT,
  degree       TEXT,                               -- 1st | 2nd | 3rd | out | unknown
  connected_at TEXT,
  profile_json TEXT NOT NULL DEFAULT '{}',
  source       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A lead's position in one campaign's funnel.
CREATE TABLE IF NOT EXISTS campaign_leads (
  id             INTEGER PRIMARY KEY,
  campaign_id    INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id        INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  step_position  INTEGER NOT NULL DEFAULT 1,
  state          TEXT NOT NULL DEFAULT 'ready',    -- ready | waiting | done | excluded | failed | replied
  eligible_at    TEXT NOT NULL DEFAULT (datetime('now')),
  entered_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_action_at TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  vars           TEXT NOT NULL DEFAULT '{}',
  exit_reason    TEXT,
  UNIQUE (campaign_id, lead_id)
);

CREATE INDEX IF NOT EXISTS idx_cl_pick
  ON campaign_leads (campaign_id, step_position, state, eligible_at);

-- Every attempt, successful or not. This table IS the rate limiter's source of truth.
CREATE TABLE IF NOT EXISTS action_log (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  campaign_id   INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  lead_id       INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  step_position INTEGER,
  action        TEXT NOT NULL,
  status        TEXT NOT NULL,                     -- ok | skip | fail | blocked
  counted       INTEGER NOT NULL DEFAULT 0,        -- 1 = consumed a quota slot
  detail        TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_log_quota
  ON action_log (account_id, action, counted, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY,
  lead_id      INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  campaign_id  INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  direction    TEXT NOT NULL,                      -- out | in
  body         TEXT NOT NULL,
  sent_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (lead_id, direction, body, sent_at)
);

-- Permanent. Nothing ever contacts a suppressed URL again, in any campaign.
CREATE TABLE IF NOT EXISTS suppression (
  profile_url TEXT PRIMARY KEY,
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── multi-platform additions ────────────────────────────────────────────────

-- Every piece of outbound content, from draft through publish. Nothing reaches a
-- platform without a row here first, so this table is the complete public record
-- of what the agents said on your behalf.
CREATE TABLE IF NOT EXISTS content (
  id           INTEGER PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform     TEXT NOT NULL,
  kind         TEXT NOT NULL,                     -- post | dm | comment | reply
  template_id  TEXT,                              -- must match an approved template
  target_ref   TEXT,                              -- profile URL / post URL / handle
  body         TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'drafted',   -- drafted | blocked | queued | published | failed | skipped
  violations   TEXT NOT NULL DEFAULT '[]',
  attempts     INTEGER NOT NULL DEFAULT 0,
  permalink    TEXT,
  meta         TEXT NOT NULL DEFAULT '{}',
  scheduled_at TEXT,
  published_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_queue ON content (account_id, state, scheduled_at);

-- Fair rotation across the approved template bank. The agent cannot pick a
-- template twice running while an unused one exists.
CREATE TABLE IF NOT EXISTS template_usage (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  used_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_template_usage ON template_usage (account_id, template_id, used_at);

-- Scheduled, non-funnel work: publish at a time, run a feed-engagement session,
-- send a DM batch. Recurring jobs re-arm themselves after each run.
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                      -- generate_post | publish_due | engage_feed | dm_batch
  payload     TEXT NOT NULL DEFAULT '{}',
  run_at      TEXT NOT NULL DEFAULT (datetime('now')),
  state       TEXT NOT NULL DEFAULT 'ready',      -- ready | running | done | failed | disabled
  recurrence  TEXT,                               -- e.g. "1d", "6h", "mon,wed,fri@09:30"; null = one-shot
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  last_run_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs (state, run_at);

-- Posts seen on a feed, so an agent never engages with the same post twice and
-- you can audit what it reacted to.
CREATE TABLE IF NOT EXISTS feed_seen (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform    TEXT NOT NULL,
  post_ref    TEXT NOT NULL,
  author      TEXT,
  excerpt     TEXT,
  action      TEXT,                               -- upvote | like | comment | skipped
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, post_ref)
);
