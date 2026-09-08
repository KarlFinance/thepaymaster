-- Which token, on which chain. Recorded per transaction rather than assumed:
-- USDT on Ethereum is a different contract from USDT on any other chain, and
-- a token address that lives in code is a token address nobody reviews.
ALTER TABLE transactions ADD COLUMN token_address TEXT;
