-- Website traffic, recorded by the router worker in front of thepaymaster.co.uk.
--
-- One row per page view: what was asked for, where from, by what. No IP address
-- is kept. A visitor is a hash of (the day's random salt, IP, user agent), so the
-- same person is one visitor for a day and cannot be followed beyond it; the
-- salts are deleted after a few days, so not even we can reverse it.
--
-- `js` is set when the page's own beacon reports back: a real browser ran the
-- page. Bots that fetch HTML without running it never set it. `bot` names a
-- crawler when its user agent says so, or marks a data-centre network.
CREATE TABLE traffic_hits (
  id          TEXT PRIMARY KEY,           -- the page view id, also handed to the page's beacon
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  host        TEXT,
  path        TEXT NOT NULL,
  query       TEXT,
  referrer    TEXT,
  ref_host    TEXT,
  utm_source  TEXT,
  utm_medium  TEXT,
  utm_campaign TEXT,
  visitor     TEXT,
  country     TEXT,
  region      TEXT,
  city        TEXT,
  asn         INTEGER,
  as_org      TEXT,
  colo        TEXT,
  ua          TEXT,
  browser     TEXT,
  os          TEXT,
  device      TEXT,
  bot         TEXT,
  status      INTEGER,
  js          INTEGER NOT NULL DEFAULT 0,
  screen      TEXT,
  lang        TEXT,
  tz          TEXT,
  engaged_ms  INTEGER,
  scroll_pct  INTEGER
);
CREATE INDEX traffic_at ON traffic_hits (at);
CREATE INDEX traffic_visitor ON traffic_hits (visitor, at);

CREATE TABLE traffic_salts (
  day   TEXT PRIMARY KEY,
  salt  TEXT NOT NULL
);

-- Which visitor sent each form, so an enquiry can be traced to the visit
-- (landing page, source, campaign) that led to it.
ALTER TABLE site_forms ADD COLUMN visitor TEXT;
ALTER TABLE enquiries ADD COLUMN visitor TEXT;
