-- The platform as an actor.
--
-- transactions.created_by must name an admin. When a verified party starts a
-- distribution from their own account, or asks for a finished one to run
-- again, nobody on staff created it — the platform did, on their instruction.
-- This row is that creator. It cannot sign in (active = 0, no password) and
-- the audit line on every such transaction names the party who asked.

INSERT OR IGNORE INTO admins (id, email, name, role, active)
VALUES ('adm_system', 'platform@thepaymaster.co.uk', 'ThePaymaster platform', 'admin', 0);
