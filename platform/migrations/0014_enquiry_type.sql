-- What kind of transaction the enquirer thinks they want.
--
-- Asked on the public form because it changes the whole conversation: only one
-- of the five is executed by the sender on chain, and the other four run
-- through our bank or an OTC desk. Knowing which before the first call saves
-- asking, and lets the transaction be created already pointing the right way.
--
-- Stored as the three fields the platform reasons with, rather than as a label
-- to be parsed later.

ALTER TABLE enquiries ADD COLUMN inbound  TEXT;   -- fiat | crypto
ALTER TABLE enquiries ADD COLUMN outbound TEXT;   -- fiat | crypto
ALTER TABLE enquiries ADD COLUMN converts INTEGER;
