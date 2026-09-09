-- An address accepted without a signature.
--
-- A recipient who wants paying at an exchange cannot sign from the deposit
-- address: the exchange holds the key. Until now that address could not be
-- paid at all. This is the alternative assurance — a member of staff has seen
-- evidence that the address belongs to the recipient's account at a named
-- custodian, and says so, with the evidence attached and their name on it.
--
-- It is a weaker assurance than a signature and the record says so in those
-- words. It covers one address: change the address and it is void. It is
-- granted by one person and can be revoked by another; both are facts in the
-- dossier. The dust test still runs before any real payment, as it does for
-- every address.

ALTER TABLE destinations ADD COLUMN proof_unavailable_at   TEXT;  -- the recipient told us they cannot sign
ALTER TABLE destinations ADD COLUMN proof_unavailable_note TEXT;

CREATE TABLE address_attestations (
  id                TEXT PRIMARY KEY,
  destination_id    TEXT NOT NULL REFERENCES destinations(id),
  address           TEXT NOT NULL,                -- the address this covers, as it was
  custodian         TEXT NOT NULL,                -- "Binance", "Kraken", "Coinbase"
  basis             TEXT NOT NULL,                -- what was seen, in the attester's words
  evidence_artefact TEXT REFERENCES artefacts(id),
  granted_by        TEXT NOT NULL,                -- admin id
  granted_at        TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_by        TEXT,
  revoked_at        TEXT,
  revoke_reason     TEXT
);

CREATE INDEX address_attestations_destination ON address_attestations (destination_id, granted_at);
