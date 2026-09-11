-- Mode C: ThePaymaster receives a digital-asset distribution into one of its
-- own client wallets and pays the recipients from it, as the Sender's
-- Paymaster Agreement (clause 6.2(c), Schedule 3) describes. The sender-
-- executes route stays; which one a transaction uses is recorded on it.
ALTER TABLE transactions ADD COLUMN execution TEXT NOT NULL DEFAULT 'sender'
  CHECK (execution IN ('sender', 'client_wallet'));
ALTER TABLE transactions ADD COLUMN client_wallet TEXT;

-- The holder of funds in Mode C is a ThePaymaster wallet, which the custody
-- table's CHECK did not allow. SQLite cannot widen a CHECK in place, so the
-- table is rebuilt, and the two tables that reference it with it (the same
-- pattern as 0012). Nothing is deleted; every row is copied across.
CREATE TABLE custody_events_v3 (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  holder         TEXT NOT NULL CHECK (holder IN (
                   'client', 'thepaymaster_hsbc', 'thepaymaster_wallet', 'otc_desk', 'none')),
  event          TEXT NOT NULL CHECK (event IN (
                   'received', 'converted', 'sent', 'fee_taken', 'returned')),
  amount_minor   INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  decimals       INTEGER NOT NULL,
  occurred_at    TEXT NOT NULL,
  evidence_id    TEXT,
  recorded_by    TEXT NOT NULL,
  recorded_by_kind TEXT NOT NULL DEFAULT 'admin'
                   CHECK (recorded_by_kind IN ('admin', 'party', 'system')),
  tx_hash        TEXT,
  tx_block       INTEGER,
  tx_verified_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO custody_events_v3 SELECT id, transaction_id, holder, event, amount_minor, currency, decimals,
  occurred_at, evidence_id, recorded_by, recorded_by_kind, tx_hash, tx_block, tx_verified_at, created_at
  FROM custody_events;

CREATE TABLE payout_legs_v3 (
  event_id         TEXT NOT NULL REFERENCES custody_events_v3(id),
  participation_id TEXT NOT NULL REFERENCES participations(id),
  PRIMARY KEY (event_id, participation_id)
);
INSERT INTO payout_legs_v3 SELECT event_id, participation_id FROM payout_legs;

CREATE TABLE bank_lines_v2 (
  id TEXT PRIMARY KEY, transaction_id TEXT REFERENCES transactions(id),
  imported_at TEXT NOT NULL DEFAULT (datetime('now')), imported_by TEXT NOT NULL,
  booked_on TEXT NOT NULL, reference TEXT NOT NULL, amount_minor INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')), currency TEXT NOT NULL,
  counterparty TEXT, raw TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE,
  matched_event_id TEXT REFERENCES custody_events_v3(id), matched_what TEXT
);
INSERT INTO bank_lines_v2 SELECT id, transaction_id, imported_at, imported_by, booked_on, reference, amount_minor,
  direction, currency, counterparty, raw, fingerprint, matched_event_id, matched_what FROM bank_lines;

DROP TABLE bank_lines;
DROP TABLE payout_legs;
DROP TABLE custody_events;
ALTER TABLE custody_events_v3 RENAME TO custody_events;
ALTER TABLE payout_legs_v3 RENAME TO payout_legs;
ALTER TABLE bank_lines_v2 RENAME TO bank_lines;
CREATE INDEX custody_transaction ON custody_events (transaction_id, occurred_at);
CREATE INDEX payout_legs_participation ON payout_legs (participation_id);
