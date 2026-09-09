-- The dossier's seal.
--
-- Everything the dossier contains already lives in the tables around it. What
-- this adds is a commitment: at a stated moment, the record consisted of
-- exactly these facts, and here is one hash that proves it.
--
-- Sealing is append-only. A second seal does not replace the first — it stands
-- beside it, and a root that has changed between the two is itself a finding
-- worth seeing. Nothing here can be edited, only added to.

CREATE TABLE dossier_seals (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  root           TEXT NOT NULL,           -- hex sha256 Merkle root
  leaf_count     INTEGER NOT NULL,
  algorithm      TEXT NOT NULL,           -- how to recompute it, in the record
  sealed_by      TEXT,
  sealed_at      TEXT NOT NULL DEFAULT (datetime('now')),

  -- Optional, later: the root written into a transaction's calldata, so the
  -- timestamp comes from the chain rather than from us.
  anchor_chain_id INTEGER,
  anchor_tx_hash  TEXT,
  anchored_at     TEXT
);

CREATE INDEX dossier_seals_tx ON dossier_seals (transaction_id, sealed_at DESC);
