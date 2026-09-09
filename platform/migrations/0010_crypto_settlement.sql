-- Evidence for a crypto leg is a transaction hash, not a document.
--
-- A PDF of a screenshot proves somebody had a screenshot. A hash can be
-- checked against the chain by anybody, for ever, without trusting us — which
-- is the whole reason the crypto rail is worth having, so the dossier should
-- carry it as a first-class thing rather than as an attachment.
ALTER TABLE custody_events ADD COLUMN tx_hash TEXT;
ALTER TABLE custody_events ADD COLUMN tx_block INTEGER;
ALTER TABLE custody_events ADD COLUMN tx_verified_at TEXT;

-- What a screening provider said about an address.
--
-- Separate from the Tether blacklist, which the gate already reads live and
-- for free. That answers "can this address receive"; this answers "should it".
CREATE TABLE wallet_screens (
  id             TEXT PRIMARY KEY,
  address        TEXT NOT NULL,
  chain_id       INTEGER NOT NULL,
  transaction_id TEXT REFERENCES transactions(id),
  party_id       TEXT REFERENCES parties(id),
  provider       TEXT NOT NULL,               -- nominis | manual
  -- Deliberately not a score. A number invites an argument about thresholds;
  -- a verdict invites a person to own it.
  verdict        TEXT NOT NULL CHECK (verdict IN ('clear', 'flagged', 'refused', 'pending')),
  risk           TEXT,
  findings       TEXT,
  reference      TEXT,
  payload        TEXT,
  decided_by     TEXT REFERENCES admins(id),
  screened_at    TEXT,
  -- Exposure changes. A clearance from three months ago is a historical fact,
  -- not a current one.
  expires_at     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX wallet_screens_address ON wallet_screens (lower(address), chain_id);
CREATE INDEX wallet_screens_transaction ON wallet_screens (transaction_id);
