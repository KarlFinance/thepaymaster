-- Which rail a transaction runs on.
--
-- Until now "which chain" was an Ethereum chain id and "which asset" was a
-- token contract address, because Ethereum was the only rail. Bitcoin has
-- neither. The rail is one string — 'eth:1:usdt', 'btc:mainnet' — and the
-- Ethereum-specific columns stay for the Ethereum rail's own use.
--
-- Every existing crypto transaction was on Ethereum: back-filled as such.

ALTER TABLE transactions ADD COLUMN rail TEXT;

UPDATE transactions SET rail = 'eth:' || chain_id || ':usdt' WHERE chain_id IS NOT NULL AND rail IS NULL;
