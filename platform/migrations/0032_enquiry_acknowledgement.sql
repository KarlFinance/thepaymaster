-- The enquirer ticks that they understand every party will be verified. The
-- exact wording they ticked is kept with the time, so "nobody told me" has an
-- answer later.
ALTER TABLE enquiries ADD COLUMN acknowledged_at TEXT;
ALTER TABLE enquiries ADD COLUMN acknowledged_text TEXT;
