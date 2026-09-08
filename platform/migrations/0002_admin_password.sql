-- Admin sign-in.
--
-- Deliberately minimal, and deliberately temporary: before this panel holds
-- anything real it should sit behind Cloudflare Access, at which point the
-- password column goes away and identity comes from the provider you already
-- use. Until then, PBKDF2-SHA512 at 210,000 iterations.
ALTER TABLE admins ADD COLUMN password_hash TEXT;
