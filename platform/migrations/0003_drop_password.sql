-- The password column goes.
--
-- Cloudflare Access is now the only gate: it verifies identity before a request
-- reaches the worker, and the worker verifies Access's signed assertion rather
-- than trusting a header. Keeping a second, weaker credential alongside it
-- would mean two ways in and only one of them watched.
ALTER TABLE admins DROP COLUMN password_hash;
