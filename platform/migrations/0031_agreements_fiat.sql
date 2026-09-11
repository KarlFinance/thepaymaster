-- The agreements each party signs, generated for the transaction and signed
-- in the flow; the manual fiat flow's two confirmations; and a place for
-- platform-wide switches (which fiat mode is on).

CREATE TABLE platform_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE agreements (
  id               TEXT PRIMARY KEY,
  transaction_id   TEXT NOT NULL REFERENCES transactions(id),
  party_id         TEXT NOT NULL REFERENCES parties(id),
  participation_id TEXT REFERENCES participations(id),
  kind             TEXT NOT NULL CHECK (kind IN ('sender_agreement', 'recipient_authorisation')),
  version          TEXT NOT NULL,                -- the template version, e.g. v2026-09
  -- The filled document as put in front of the signer, and its hash. A signature
  -- is over this exact content; if the transaction changes, the hash changes and
  -- the signature no longer covers the current facts.
  content_json     TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  signed_name      TEXT NOT NULL,
  signed_at        TEXT NOT NULL DEFAULT (datetime('now')),
  signed_ip        TEXT,
  signed_agent     TEXT,
  signer_party_id  TEXT REFERENCES parties(id),  -- the human (a team member may sign for an organisation)
  artefact_id      TEXT REFERENCES artefacts(id) -- the signed PDF in the document store
);
CREATE INDEX agreements_tx ON agreements (transaction_id, party_id, signed_at);

-- Manual fiat flow: the sender says the money has gone; each recipient says it arrived.
ALTER TABLE transactions ADD COLUMN sender_sent_at TEXT;
ALTER TABLE transactions ADD COLUMN sender_sent_note TEXT;
ALTER TABLE participations ADD COLUMN receipt_confirmed_at TEXT;
