-- Written authority for us to act for a sender.
--
-- Some senders will not want to drive the setup themselves — the transaction
-- is unfamiliar, the stakes are high, and they would rather talk it through
-- and have us enter it. That is a perfectly reasonable way to work, but it
-- must never be an informal one: if we name the recipients and set the
-- amounts, the record has to show that the sender asked us to, in their own
-- words, at a stated moment, and that they saw exactly what they were
-- authorising.
--
-- What is stored is the wording itself, not a reference to wording held
-- elsewhere. A mandate that says "agreed to version 3 of the standard terms"
-- is worth nothing once version 4 exists.

CREATE TABLE mandates (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  party_id       TEXT NOT NULL REFERENCES parties(id),

  -- The exact text put in front of the signer, kept verbatim.
  wording        TEXT NOT NULL,
  -- What it permits, so the limits are on the record and not just in the prose.
  scope          TEXT NOT NULL,

  requested_by   TEXT REFERENCES admins(id),
  requested_at   TEXT NOT NULL DEFAULT (datetime('now')),

  -- How it was signed. 'typed' is a name typed into the form with an explicit
  -- confirmation; 'wallet' is an EIP-191 signature from the sending wallet.
  method         TEXT CHECK (method IN ('typed', 'wallet')),
  signed_name    TEXT,
  signature      TEXT,
  signed_at      TEXT,
  signed_ip      TEXT,
  signed_agent   TEXT,

  -- Withdrawn by the sender, or by us. Never deleted.
  revoked_at     TEXT,
  revoked_by     TEXT,
  revoked_reason TEXT,

  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX mandates_tx ON mandates (transaction_id, signed_at DESC);
