-- Certificates on chain.
--
-- One soulbound token per party's certificate on a sealed record, minted by
-- the platform's attestation key to the address the party proved. The chain
-- carries the token id (derived from the record root and the party) and
-- nothing else; the name, the amount and the story stay in the dossier. What
-- we record here is where each certificate went and the transaction that put
-- it there.

CREATE TABLE badge_contracts (
  chain_id     INTEGER PRIMARY KEY,
  address      TEXT NOT NULL,
  deploy_tx    TEXT NOT NULL,
  deployed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  deployed_by  TEXT NOT NULL
);

CREATE TABLE badges (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  party_id       TEXT REFERENCES parties(id),      -- null: the transaction's own certificate
  seal_id        TEXT NOT NULL REFERENCES dossier_seals(id),
  chain_id       INTEGER NOT NULL,
  contract       TEXT NOT NULL,
  token_id       TEXT NOT NULL,                     -- 0x + 64 hex
  to_address     TEXT NOT NULL,
  tx_hash        TEXT NOT NULL,
  minted_at      TEXT NOT NULL DEFAULT (datetime('now')),
  minted_by      TEXT NOT NULL,
  UNIQUE (chain_id, token_id)
);
CREATE INDEX badges_tx ON badges (transaction_id);
