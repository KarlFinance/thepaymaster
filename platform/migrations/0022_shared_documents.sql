-- Which staff-uploaded documents a party may take away in their own folder.
--
-- A party's own uploads are theirs. A document staff put on their record — a
-- screening report, an agreement — is ours unless we say otherwise, because
-- some contain third-party information the party has no right to. Marked
-- shared, it goes into the folder they download and the statement lists it.

ALTER TABLE artefacts ADD COLUMN shared_with_party INTEGER NOT NULL DEFAULT 0;
