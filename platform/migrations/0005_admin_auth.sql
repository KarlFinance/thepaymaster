-- Admin credentials.
--
-- Email and password with a time-based code from an authenticator app. This
-- replaces Cloudflare Access as the gate, which traded central revocation and
-- no stored password for a login the team owns and can manage themselves.
--
-- Both factors are stored the same way: never in a form that can be replayed.
-- The password is a PBKDF2-SHA512 digest; the TOTP secret has to be stored
-- recoverably, because verifying a code means recomputing it, so it is the one
-- thing here worth protecting at the database level rather than by hashing.

ALTER TABLE admins ADD COLUMN password_hash TEXT;
ALTER TABLE admins ADD COLUMN totp_secret TEXT;
ALTER TABLE admins ADD COLUMN totp_confirmed_at TEXT;
-- Set when someone must choose a new password before doing anything else.
ALTER TABLE admins ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admins ADD COLUMN last_login_at TEXT;

-- Kept in the database rather than only in a signed cookie, so that disabling
-- an account or changing a password ends every session it had immediately.
CREATE TABLE admin_sessions (
  id          TEXT PRIMARY KEY,
  hash        TEXT NOT NULL UNIQUE,
  admin_id    TEXT NOT NULL REFERENCES admins(id),
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX admin_sessions_admin ON admin_sessions (admin_id);

-- A code is six digits and lives for thirty seconds, which is brief enough to
-- be worth guessing at speed. Recording every attempt lets a run of failures
-- be seen, and refused.
CREATE TABLE login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  email      TEXT NOT NULL,
  ip         TEXT,
  stage      TEXT NOT NULL CHECK (stage IN ('password', 'totp')),
  ok         INTEGER NOT NULL
);

CREATE INDEX login_attempts_email ON login_attempts (lower(email), at);
CREATE INDEX login_attempts_ip ON login_attempts (ip, at);
