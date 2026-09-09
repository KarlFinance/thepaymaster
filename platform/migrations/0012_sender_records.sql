-- A custody event the sender recorded.
--
-- custody_events.recorded_by pointed at admins(id), which quietly assumed that
-- only staff ever record a movement of money. That is true of the four types
-- we settle by hand, and false of the one that matters most here: in a
-- crypto-to-crypto distribution with no conversion, the sender executes every
-- leg from their own wallet. They are the only party who can say it happened,
-- and the foreign key made it impossible to record that they had.
--
-- So the column keeps its meaning but loses its assumption, and gains a
-- companion saying which kind of actor it names. Nothing is deleted: every
-- existing row is copied across and marked 'admin', which is what it was.
--
-- SQLite cannot drop a constraint in place, so the table is rebuilt. payout_legs
-- is rebuilt with it because it references custody_events and would otherwise
-- hold the old table alive.

CREATE TABLE custody_events_v2 (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  holder         TEXT NOT NULL CHECK (holder IN (
                   'client', 'thepaymaster_hsbc', 'otc_desk', 'none')),
  event          TEXT NOT NULL CHECK (event IN (
                   'received', 'converted', 'sent', 'fee_taken', 'returned')),
  amount_minor   INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  decimals       INTEGER NOT NULL,
  occurred_at    TEXT NOT NULL,
  evidence_id    TEXT,
  -- Who said so, and what kind of person that is. No foreign key: it may name
  -- an admin or a party, and the audit log records the same identity beside it.
  recorded_by    TEXT NOT NULL,
  recorded_by_kind TEXT NOT NULL DEFAULT 'admin'
                   CHECK (recorded_by_kind IN ('admin', 'party', 'system')),
  tx_hash        TEXT,
  tx_block       INTEGER,
  tx_verified_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO custody_events_v2 (id, transaction_id, holder, event, amount_minor,
  currency, decimals, occurred_at, evidence_id, recorded_by, recorded_by_kind,
  tx_hash, tx_block, tx_verified_at, created_at)
SELECT id, transaction_id, holder, event, amount_minor, currency, decimals,
       occurred_at, evidence_id, recorded_by, 'admin',
       tx_hash, tx_block, tx_verified_at, created_at
  FROM custody_events;

CREATE TABLE payout_legs_v2 (
  event_id         TEXT NOT NULL REFERENCES custody_events_v2(id),
  participation_id TEXT NOT NULL REFERENCES participations(id),
  PRIMARY KEY (event_id, participation_id)
);

INSERT INTO payout_legs_v2 (event_id, participation_id)
SELECT event_id, participation_id FROM payout_legs;

DROP TABLE payout_legs;
DROP TABLE custody_events;

ALTER TABLE custody_events_v2 RENAME TO custody_events;
ALTER TABLE payout_legs_v2 RENAME TO payout_legs;

CREATE INDEX custody_transaction ON custody_events (transaction_id, occurred_at);
CREATE INDEX payout_legs_participation ON payout_legs (participation_id);
