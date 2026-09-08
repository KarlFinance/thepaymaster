-- Proving a wallet, on both sides of a crypto transaction.
--
-- The nonce is stored when the challenge is first shown, so verification uses
-- the same words the holder actually saw. Generating it fresh at verification
-- time would mean checking a signature over a message nobody was ever shown.
ALTER TABLE destinations ADD COLUMN proof_nonce TEXT;
ALTER TABLE destinations ADD COLUMN proof_signature TEXT;
ALTER TABLE destinations ADD COLUMN proved_at TEXT;

ALTER TABLE sending_wallets ADD COLUMN proof_nonce TEXT;
ALTER TABLE sending_wallets ADD COLUMN label TEXT;

-- Where our own fee goes on a crypto transaction. Recorded per transaction
-- rather than as a constant, because the right answer can differ by chain and
-- because a fee address that lives in code is a fee address nobody reviews.
ALTER TABLE transactions ADD COLUMN fee_wallet TEXT;
ALTER TABLE transactions ADD COLUMN chain_id INTEGER;
