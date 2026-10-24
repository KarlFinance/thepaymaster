-- Every website form submission also creates an enquiry, so everything that
-- comes in lands in one queue. The two rows point at each other.
ALTER TABLE site_forms ADD COLUMN enquiry_id TEXT;
ALTER TABLE enquiries ADD COLUMN site_form_id TEXT;
