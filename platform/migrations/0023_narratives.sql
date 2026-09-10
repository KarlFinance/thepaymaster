-- The words around the facts.
--
-- A bank reading a dossier wants two things the facts alone do not give: an
-- executive summary of the transaction in a paragraph, and the party's
-- source-of-funds / source-of-wealth narrative — where the money came from,
-- in prose, with the documents referenced. Both are written by staff, both
-- are facts in the record (the summary on the transaction row, each narrative
-- as its own leaf), and a narrative is never edited: a new version is a new
-- row, and the record shows them all.

ALTER TABLE transactions ADD COLUMN summary TEXT;

CREATE TABLE narratives (
  id             TEXT PRIMARY KEY,
  party_id       TEXT NOT NULL REFERENCES parties(id),
  transaction_id TEXT REFERENCES transactions(id),   -- null: about the party generally
  kind           TEXT NOT NULL DEFAULT 'source_of_funds',
  text           TEXT NOT NULL,
  written_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX narratives_party ON narratives (party_id, created_at);
