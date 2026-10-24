-- Submissions from the website's own forms (replacing the HubSpot embeds).
-- One row per submission; the fields as submitted are kept verbatim in JSON so
-- a form can change shape without a migration.
CREATE TABLE site_forms (
  id          TEXT PRIMARY KEY,
  form        TEXT NOT NULL,                 -- contact-us | crypto-transactions | briefing-evaluation | introducer-program | recipient-onboarding
  name        TEXT,
  email       TEXT,
  phone       TEXT,
  fields_json TEXT NOT NULL,
  files_json  TEXT,                          -- [{key, filename, bytes, type}] in R2 under site-forms/<id>/
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'closed', 'spam')),
  status_at   TEXT,
  status_by   TEXT,
  ip          TEXT,
  agent       TEXT,
  referer     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX site_forms_status ON site_forms (status, created_at);
