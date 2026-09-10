-- The bank rail: fiat legs paid from the client mandated account.
--
-- Two things a bank leg needs that a chain leg gets for free. Proof of the
-- account: we send a penny from the mandated account carrying a short code as
-- the reference, and the recipient reads the code off their statement and
-- types it back — the bank's own ledger is the channel, as the chain is for a
-- wallet signature. And verification of payment: the mandated account's
-- statement, imported line by line, matched to the payments we expect by the
-- references we put on them. The statement lines are facts in the record.

ALTER TABLE destinations ADD COLUMN penny_code      TEXT;
ALTER TABLE destinations ADD COLUMN penny_sent_at   TEXT;
ALTER TABLE destinations ADD COLUMN penny_attempts  INTEGER NOT NULL DEFAULT 0;

CREATE TABLE bank_lines (
  id               TEXT PRIMARY KEY,
  transaction_id   TEXT REFERENCES transactions(id),   -- set once matched
  imported_at      TEXT NOT NULL DEFAULT (datetime('now')),
  imported_by      TEXT NOT NULL,
  booked_on        TEXT NOT NULL,                       -- YYYY-MM-DD
  reference        TEXT NOT NULL,                       -- as the bank shows it
  amount_minor     INTEGER NOT NULL,                    -- always positive
  direction        TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  currency         TEXT NOT NULL,
  counterparty     TEXT,                                -- name/account text if the bank gives it
  raw              TEXT NOT NULL,                       -- the line as imported
  fingerprint      TEXT NOT NULL UNIQUE,                -- sha256 of the line: import twice, record once
  matched_event_id TEXT REFERENCES custody_events(id),
  matched_what     TEXT                                 -- receipt | leg:<participation> | fee | penny:<destination>
);
CREATE INDEX bank_lines_tx ON bank_lines (transaction_id);
CREATE INDEX bank_lines_ref ON bank_lines (reference);
