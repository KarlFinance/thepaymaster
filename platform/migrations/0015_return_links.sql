-- Letting a client back in on a second device.
--
-- An invitation link is single-use on purpose: it is the thing that opens an
-- account, and a reusable one sitting in an inbox is a standing key. But the
-- session it creates lives in one browser, so a client who opened the email on
-- a phone and later sits down at a laptop has no way back in — during KYC,
-- which is exactly when somebody wants a proper keyboard and a scanner.
--
-- A third purpose fixes that: a short-lived link, requested by the client
-- themselves, that signs an existing party back in and nothing more. It cannot
-- create an account, join a transaction, or change who anybody is.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt. Rows are
-- carried across; nothing is dropped.

CREATE TABLE tokens_new (
  id             TEXT PRIMARY KEY,
  hash           TEXT NOT NULL UNIQUE,
  purpose        TEXT NOT NULL CHECK (purpose IN ('start', 'join', 'return')),
  email          TEXT NOT NULL,
  transaction_id TEXT REFERENCES transactions(id),
  participation_id TEXT REFERENCES participations(id),
  party_id       TEXT REFERENCES parties(id),
  expires_at     TEXT NOT NULL,
  used_at        TEXT,
  used_ip        TEXT,
  created_by     TEXT REFERENCES admins(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO tokens_new (id, hash, purpose, email, transaction_id,
                        participation_id, expires_at, used_at, used_ip,
                        created_by, created_at)
  SELECT id, hash, purpose, email, transaction_id, participation_id,
         expires_at, used_at, used_ip, created_by, created_at FROM tokens;

DROP TABLE tokens;
ALTER TABLE tokens_new RENAME TO tokens;
