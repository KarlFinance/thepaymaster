-- ThePaymaster's own wallets, one row per role, asset and chain. A transaction
-- picks its fee wallet from here rather than having an address typed into it.
-- Control is proved the way a recipient proves theirs: a signature from the key.
CREATE TABLE house_wallets (
  id              TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('fee', 'client')),   -- fee: where the 1% lands; client: Mode C receiving wallet
  rail            TEXT NOT NULL,                                     -- eth:1:usdt | btc:mainnet | …
  address         TEXT NOT NULL,
  added_by        TEXT REFERENCES admins(id),
  added_at        TEXT NOT NULL DEFAULT (datetime('now')),
  proof_nonce     TEXT,
  proof_signature TEXT,
  proved_at       TEXT,
  retired_at      TEXT,
  retired_by      TEXT REFERENCES admins(id),
  retired_reason  TEXT
);
CREATE INDEX house_wallets_rail ON house_wallets (rail, role, retired_at);

-- The two Ray gave on 11 September 2026, to start with. Unproved until a
-- signature from each key is recorded on the Wallets page.
INSERT INTO house_wallets (id, label, role, rail, address) VALUES
  ('hw_eth_usdt_fee', 'ThePaymaster fee wallet — USDT on Ethereum', 'fee', 'eth:1:usdt', '0xDA16b07F7b7Fc8A3CD9a76dcfaD828b15Bd14428'),
  ('hw_btc_fee',      'ThePaymaster fee wallet — Bitcoin',          'fee', 'btc:mainnet', 'bc1q3uwr70ypnfwya9n4qr2vntpw4hfvgptc5jp9q8');
