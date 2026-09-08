-- Phase 4: knowing who we are dealing with.
--
-- Two shapes. An individual gives their name, date of birth, nationality and
-- where they live, and uploads a passport and something showing their address.
-- A company gives its incorporation details and its people — and each of those
-- people is an individual party in their own right who must pass the same
-- checks. That is the whole reason parties and relationships are separate
-- tables: a director of one client company is often a shareholder of another,
-- and having verified them once should count.
--
-- Nothing here decides anything. The checks themselves are run by Themis, and
-- what is recorded is what we collected, what was concluded, and by whom.

PRAGMA foreign_keys = ON;

-- Individuals
ALTER TABLE parties ADD COLUMN date_of_birth TEXT;
ALTER TABLE parties ADD COLUMN nationality TEXT;
ALTER TABLE parties ADD COLUMN residence_country TEXT;
ALTER TABLE parties ADD COLUMN address TEXT;

-- Companies
ALTER TABLE parties ADD COLUMN incorporated_in TEXT;
ALTER TABLE parties ADD COLUMN incorporated_on TEXT;

-- Set when the party has finished giving us what we asked for, so the review
-- queue can tell "still filling it in" from "waiting on us".
ALTER TABLE parties ADD COLUMN kyc_submitted_at TEXT;

-- Who is behind a company.
--
-- Both sides are parties, so a director carries their own verification and a
-- person who appears behind two clients is one record, verified once.
CREATE TABLE relationships (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES parties(id),
  person_id    TEXT NOT NULL REFERENCES parties(id),
  relation     TEXT NOT NULL CHECK (relation IN
                 ('director', 'ubo', 'shareholder', 'signatory')),
  -- Basis points, so 25.5% is 2550 and there is no float anywhere near an
  -- ownership figure that decides whether someone is a beneficial owner.
  ownership_bps INTEGER,
  appointed_on TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, person_id, relation)
);

CREATE INDEX relationships_company ON relationships (company_id);
CREATE INDEX relationships_person ON relationships (person_id);

-- Which provider looked at this, and what they said.
--
-- The verifications table already carries the decision. These columns carry
-- the provider's own reference and payload, so a conclusion can always be
-- traced back to the thing that produced it — including when that thing was a
-- person reading a Themis report.
ALTER TABLE verifications ADD COLUMN reference TEXT;
ALTER TABLE verifications ADD COLUMN payload TEXT;
ALTER TABLE verifications ADD COLUMN party_kind TEXT;
