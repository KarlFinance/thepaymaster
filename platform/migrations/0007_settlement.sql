-- Which recipient a payment was for.
--
-- A custody event records that money left; this records who it went to. They
-- are separate because not every movement has a recipient — funds arriving,
-- the fee coming off, a conversion at the OTC desk — and forcing a nullable
-- recipient onto every event would make "no recipient" and "recipient not
-- recorded" the same thing.
CREATE TABLE payout_legs (
  event_id         TEXT NOT NULL REFERENCES custody_events(id),
  participation_id TEXT NOT NULL REFERENCES participations(id),
  PRIMARY KEY (event_id, participation_id)
);

CREATE INDEX payout_legs_participation ON payout_legs (participation_id);

-- What was decided when the amount that arrived was not the amount expected.
-- Kept on the transaction so the dossier can say what happened and on whose
-- say-so, rather than leaving a discrepancy to be inferred from two numbers.
ALTER TABLE transactions ADD COLUMN variance_note TEXT;
ALTER TABLE transactions ADD COLUMN variance_decided_by TEXT;
ALTER TABLE transactions ADD COLUMN variance_decided_at TEXT;
