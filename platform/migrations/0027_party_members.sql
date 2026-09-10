-- Several people acting for one party.
--
-- A member is a party in their own right (their own login, their own KYC)
-- with a role on an organisation: owner, approver, preparer, viewer. The
-- organisation's own login is its owner. Membership is accepted by signing in;
-- it ends by revocation and the row stays, so the record shows who could act
-- for whom and when.

CREATE TABLE party_members (
  id               TEXT PRIMARY KEY,
  party_id         TEXT NOT NULL REFERENCES parties(id),       -- the organisation
  member_party_id  TEXT NOT NULL REFERENCES parties(id),       -- the person
  role             TEXT NOT NULL CHECK (role IN ('owner', 'approver', 'preparer', 'viewer')),
  invited_by       TEXT NOT NULL,
  invited_at       TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at      TEXT,
  revoked_at       TEXT
);
CREATE INDEX party_members_member ON party_members (member_party_id, revoked_at);
CREATE INDEX party_members_party ON party_members (party_id);
