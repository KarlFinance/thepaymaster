-- A transaction the sender started and runs themselves: everything that is not
-- a staff decision moves on its own, and staff are emailed when one is needed.
ALTER TABLE transactions ADD COLUMN self_serve INTEGER NOT NULL DEFAULT 0;
