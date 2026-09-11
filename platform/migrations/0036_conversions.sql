-- The desk stage: a conversion between fiat and a digital asset, executed by
-- the OTC desk outside the platform and recorded here — instruction first,
-- execution when the desk confirms. The desk's own fee is charged at source
-- and is never collected by ThePaymaster; it is recorded so the record adds up.
CREATE TABLE conversions (
  id               TEXT PRIMARY KEY,
  transaction_id   TEXT NOT NULL REFERENCES transactions(id),
  direction        TEXT NOT NULL CHECK (direction IN ('buy', 'sell')),   -- buy: fiat → digital asset; sell: digital asset → fiat
  desk             TEXT NOT NULL,
  desk_ref         TEXT,
  from_currency    TEXT NOT NULL,
  from_decimals    INTEGER NOT NULL,
  from_minor       INTEGER NOT NULL,          -- handed to the desk (after our fee)
  desk_fee_bps     INTEGER NOT NULL,          -- the desk's charge, at source
  desk_fee_minor   INTEGER,                   -- in from_currency, as the desk confirmed it
  rate             TEXT,                      -- to per from, as the desk stated it
  to_currency      TEXT NOT NULL,
  to_decimals      INTEGER NOT NULL,
  to_minor         INTEGER,                   -- what came back, net of the desk's fee and spread
  instructed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  instructed_by    TEXT,
  executed_at      TEXT,
  recorded_by      TEXT,
  evidence_id      TEXT REFERENCES artefacts(id),
  custody_event_id TEXT REFERENCES custody_events(id),
  note             TEXT,
  cancelled_at     TEXT,
  cancelled_reason TEXT
);
CREATE INDEX conversions_tx ON conversions (transaction_id, instructed_at);
