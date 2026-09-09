-- Provider credentials, held here so staff can change them without a deploy.
--
-- A key in a database is more exposed than a key in a Worker secret: it is in
-- backups, in exports, and behind whatever else can reach the database. So the
-- value is never stored as it was typed. It is encrypted with AES-GCM under a
-- key that lives in a Worker secret (SETTINGS_KEY) and is not in this table,
-- which means a copy of the database on its own is not enough to use it.
--
-- What is kept in the clear is deliberately only what staff need in order to
-- recognise a key: its last four characters and when it was set. The value is
-- never rendered back into a page, not even to the admin who typed it.

CREATE TABLE provider_settings (
  provider     TEXT PRIMARY KEY,       -- nominis | sumsub | resend | eth_rpc …
  enabled      INTEGER NOT NULL DEFAULT 0,

  -- AES-GCM. The nonce is per-write and stored beside the ciphertext; both are
  -- base64. A second field exists because some providers need a pair.
  secret_iv    TEXT,
  secret_ct    TEXT,
  second_iv    TEXT,
  second_ct    TEXT,

  -- Enough to tell one key from another without revealing either.
  hint         TEXT,
  second_hint  TEXT,

  updated_by   TEXT REFERENCES admins(id),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  -- The last time the credential was actually exercised against the provider.
  checked_at   TEXT,
  checked_note TEXT
);
