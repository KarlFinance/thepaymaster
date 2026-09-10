-- The data room: a party's dossier shown to somebody who is not a party.
--
-- A bank's compliance officer needs to read the certification and the record
-- without an account and without emailing PDFs about. An invitation is a
-- link: one viewer, one party's dossier, an expiry, revocable, and every
-- opening logged with when and from where. What they see is what the party
-- would download themselves — the certification, the record, and (only if
-- the inviter said so) the documents — watermarked with the viewer's name
-- and the time, so a copy that leaks says where it came from.

CREATE TABLE room_invites (
  id                TEXT PRIMARY KEY,
  transaction_id    TEXT NOT NULL REFERENCES transactions(id),
  party_id          TEXT NOT NULL REFERENCES parties(id),
  token_hash        TEXT NOT NULL UNIQUE,
  viewer_name       TEXT NOT NULL,              -- "J. Patel, HSBC Compliance"
  viewer_email      TEXT,
  include_documents INTEGER NOT NULL DEFAULT 0,
  created_by_kind   TEXT NOT NULL,              -- party | admin
  created_by        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  revoked_at        TEXT,
  opens             INTEGER NOT NULL DEFAULT 0,
  first_opened_at   TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX room_invites_party ON room_invites (transaction_id, party_id, created_at);

CREATE TABLE room_access (
  id         TEXT PRIMARY KEY,
  invite_id  TEXT NOT NULL REFERENCES room_invites(id),
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  ip         TEXT,
  what       TEXT NOT NULL                       -- room | certification | record | record.json | doc:<id>
);
CREATE INDEX room_access_invite ON room_access (invite_id, at);
