-- Taking a sending wallet back off a transaction.
--
-- A sender adds a wallet, proves it, then realises the funds are somewhere
-- else — or adds one by mistake. Until now there was no way to remove it, and
-- because every sending wallet must be proved before the gate opens, a wallet
-- added in error blocked the whole transaction with nothing to be done about
-- it.
--
-- Removed rather than deleted. The row stays, along with any proof already
-- given, because "this wallet was declared and then withdrawn" is a fact worth
-- keeping — particularly if the same address turns up later. Everything that
-- gates on sending wallets ignores the removed ones.

ALTER TABLE sending_wallets ADD COLUMN removed_at TEXT;
ALTER TABLE sending_wallets ADD COLUMN removed_by TEXT;
