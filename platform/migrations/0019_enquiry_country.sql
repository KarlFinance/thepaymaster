-- Where the enquirer is.
--
-- Asked on the public form as a list rather than a text box, because the
-- jurisdiction changes what we can do and who must be screened, and "UK",
-- "U.K.", "England" and "Britain" are four spellings of one answer. Stored as
-- ISO 3166-1 alpha-2.

ALTER TABLE enquiries ADD COLUMN country TEXT;
