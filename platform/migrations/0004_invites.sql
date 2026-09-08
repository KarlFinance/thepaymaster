-- Phase 3: getting people in.
--
-- Two kinds of link go out by email. A 'start' link asks a sender to set up
-- their own transaction — who they are, who needs paying. A 'join' link brings
-- a named party into a transaction that already exists.
--
-- The token in the URL is never stored. Only its SHA-256 is, so a copy of this
-- database is not a set of working keys to everybody's transactions. Lookup is
-- by hash, which is one indexed read and no less convenient.

PRAGMA foreign_keys = ON;

CREATE TABLE tokens (
  id             TEXT PRIMARY KEY,
  -- SHA-256 of the secret that was emailed. The secret itself exists only in
  -- that email and in the recipient's browser.
  hash           TEXT NOT NULL UNIQUE,
  purpose        TEXT NOT NULL CHECK (purpose IN ('start', 'join')),
  -- Bound to one address. A link forwarded to someone else still only opens
  -- the account it was issued for.
  email          TEXT NOT NULL,
  transaction_id TEXT REFERENCES transactions(id),
  participation_id TEXT REFERENCES participations(id),
  expires_at     TEXT NOT NULL,
  -- A link is spent the first time it is exchanged for a session. Reuse is a
  -- signal worth seeing, so it is recorded rather than merely refused.
  used_at        TEXT,
  used_ip        TEXT,
  created_by     TEXT REFERENCES admins(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX tokens_email ON tokens (lower(email), purpose);
CREATE INDEX tokens_transaction ON tokens (transaction_id);

-- Client sessions live here rather than only in a cookie, so that removing
-- somebody from a transaction ends their access immediately instead of
-- whenever their cookie happens to expire.
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  hash        TEXT NOT NULL UNIQUE,
  party_id    TEXT NOT NULL REFERENCES parties(id),
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX sessions_party ON sessions (party_id);

-- A sender fills in their own transaction, and we check it before anyone else
-- is invited. These record that the sender has finished and handed it back.
ALTER TABLE transactions ADD COLUMN submitted_at TEXT;
ALTER TABLE transactions ADD COLUMN submitted_by TEXT;
