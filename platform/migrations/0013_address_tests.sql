-- A payment sent to prove an address can receive, before the real one.
--
-- The unrecoverable failure in this business is money arriving somewhere it
-- cannot be retrieved from: a mistyped address, a contract that accepts tokens
-- and cannot move them, an address frozen between review and execution. Every
-- check we run before that point is inference — the chain agreeing that an
-- address exists, is not blacklisted, has no code. None of it is proof that a
-- transfer to that address lands.
--
-- One unit of the token is proof. It costs a few pence of gas per address and
-- it converts the last inference into a fact, which is a trade worth making at
-- any size and unarguable at this one.
--
-- Kept separately from custody_events on purpose: a test payment is not part
-- of the settlement, and folding it in would make the amounts wrong.

CREATE TABLE address_tests (
  id               TEXT PRIMARY KEY,
  transaction_id   TEXT NOT NULL REFERENCES transactions(id),
  -- Null for our own fee wallet, which is tested like everybody else's.
  participation_id TEXT REFERENCES participations(id),
  address          TEXT NOT NULL,
  chain_id         INTEGER NOT NULL,
  token            TEXT NOT NULL,
  amount_minor     INTEGER NOT NULL,
  tx_hash          TEXT NOT NULL,
  tx_block         INTEGER,
  verified_at      TEXT,
  sent_by          TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX address_tests_tx ON address_tests (transaction_id);
CREATE UNIQUE INDEX address_tests_hash ON address_tests (tx_hash);
