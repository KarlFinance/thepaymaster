-- ThePaymaster — the spine.
--
-- Five transaction types, one object. A transaction has an inbound leg and an
-- outbound leg, each fiat or crypto, plus a conversion flag; the five named
-- types are the valid combinations. What a recipient must supply is decided by
-- the outbound leg alone, and whether the sender must prove wallets by the
-- inbound leg. Nothing else in the flow differs between them.
--
-- Money is never a float. Every amount is an integer in the minor unit of its
-- own currency — pence for GBP, 6 decimals for USDT — with the scale recorded
-- alongside it so nothing has to be inferred.
--
-- Nothing here is ever updated in place without the audit log recording it.
-- The log is append-only and is the reason this system is worth anything: the
-- product is not the payment, it is being able to say afterwards exactly what
-- happened, when, and on whose authority.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

CREATE TABLE admins (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'admin'   -- admin | owner
                 CHECK (role IN ('admin', 'owner')),
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A party is a person or a company, and exists independently of any one
-- transaction. That is the whole point of the verified tick: a party KYC'd for
-- one deal is reusable for the next.
CREATE TABLE parties (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('individual', 'company')),
  display_name TEXT NOT NULL,
  legal_name   TEXT,
  email        TEXT NOT NULL,
  phone        TEXT,
  -- Consent to be contacted on WhatsApp, with the moment it was given. A
  -- consent without a timestamp is not a consent.
  whatsapp_ok  INTEGER NOT NULL DEFAULT 0,
  whatsapp_consent_at TEXT,
  country      TEXT,
  company_no   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX parties_email ON parties (lower(email));

-- Verification is history, not a flag.
--
-- A party cleared for a fifty thousand pound deal is not thereby cleared for a
-- five million pound one, and a clearance from eight months ago proves nothing
-- today because sanctions lists move. So each verification records the value it
-- was good for and the date it stops being good.
CREATE TABLE verifications (
  id           TEXT PRIMARY KEY,
  party_id     TEXT NOT NULL REFERENCES parties(id),
  kind         TEXT NOT NULL CHECK (kind IN ('kyc', 'kyb', 'sanctions', 'wallet_screen')),
  provider     TEXT NOT NULL,                  -- sumsub | nominis | manual
  provider_ref TEXT,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'passed', 'failed', 'expired')),
  -- The ceiling this clearance covers, in GBP pence. Above it, re-verify.
  band_ceiling_minor INTEGER,
  verified_at  TEXT,
  expires_at   TEXT,
  decided_by   TEXT REFERENCES admins(id),
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX verifications_party ON verifications (party_id, kind, status);

-- ---------------------------------------------------------------------------
-- The front door
-- ---------------------------------------------------------------------------

-- First contact. This is the first artefact of the dossier, not a lead in a
-- CRM: what the client said the deal was, before anyone had done any work.
CREATE TABLE enquiries (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  whatsapp_ok   INTEGER NOT NULL DEFAULT 0,
  contact_pref  TEXT CHECK (contact_pref IN ('zoom', 'whatsapp', 'either')),
  -- What they say the transaction is. All of it may turn out to be wrong; it
  -- is recorded as said.
  amount_minor  INTEGER,
  currency      TEXT,
  expected_on   TEXT,
  likelihood    TEXT CHECK (likelihood IN ('exploring', 'likely', 'committed')),
  detail        TEXT,
  source        TEXT,                          -- which page or campaign
  status        TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new', 'contacted', 'call_booked',
                                    'converted', 'dead')),
  transaction_id TEXT,                         -- set when it becomes one
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX enquiries_status ON enquiries (status, created_at);

-- ---------------------------------------------------------------------------
-- Transactions
-- ---------------------------------------------------------------------------

CREATE TABLE transactions (
  id            TEXT PRIMARY KEY,
  -- Human-speakable on a call, and eventually hashed into an on-chain deal id.
  ref           TEXT NOT NULL UNIQUE,          -- TPM-2026-0043
  name          TEXT NOT NULL,
  detail        TEXT,

  -- The two legs. Everything type-specific is derived from these three fields.
  inbound       TEXT NOT NULL CHECK (inbound  IN ('fiat', 'crypto')),
  outbound      TEXT NOT NULL CHECK (outbound IN ('fiat', 'crypto')),
  converts      INTEGER NOT NULL DEFAULT 0,

  currency_in   TEXT NOT NULL,                 -- GBP | USDT | ...
  currency_out  TEXT NOT NULL,
  decimals_in   INTEGER NOT NULL,              -- 2 for GBP, 6 for USDT
  decimals_out  INTEGER NOT NULL,
  chain         TEXT,                          -- ethereum | arbitrum, if crypto

  -- Fee. One rate, two mechanics: deducted on arrival for anything that passes
  -- through an account, and a recipient inside the same atomic transaction on
  -- the non-custodial rail.
  fee_bps       INTEGER NOT NULL DEFAULT 100,  -- 100 bps = 1%
  -- 'deducted'  : the sender's figure is fixed, recipients share what is left
  -- 'grossed_up': the recipients' figures are fixed, the sender sends more.
  --               The gross is total / (1 - fee), NOT total * (1 + fee).
  fee_mode      TEXT NOT NULL DEFAULT 'deducted'
                  CHECK (fee_mode IN ('deducted', 'grossed_up')),
  -- Dividing rarely comes out even. Whoever this points at absorbs the odd
  -- unit, so the split always reconciles and the dossier can say why.
  remainder_to  TEXT REFERENCES parties(id),

  gross_expected_minor INTEGER,                -- what should arrive
  gross_received_minor INTEGER,                -- what did

  -- The Commercial Agent Exemption at paragraph 2(b) is only available to an
  -- agent acting for one side. Recording which side, per transaction, with the
  -- agency agreement filed as an artefact, turns a claim about the business
  -- into a documented fact about the deal.
  acting_for    TEXT CHECK (acting_for IN ('payer', 'payee')),

  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
                  'draft',            -- we are filling it in
                  'awaiting_parties', -- invites out, details coming back
                  'kyc',              -- parties onboarding
                  'ready',            -- every gate green
                  'settling',         -- money moving
                  'settled',
                  'closed',
                  'abandoned',        -- client walked away
                  'declined'          -- we said no
                )),
  -- Deals die, and why they died is worth as much as why they closed.
  closed_reason TEXT,

  created_by    TEXT NOT NULL REFERENCES admins(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX transactions_status ON transactions (status, updated_at);

-- Who is on a transaction and in what capacity. A party may be on many
-- transactions; a transaction has many parties.
CREATE TABLE participations (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  party_id       TEXT NOT NULL REFERENCES parties(id),
  role           TEXT NOT NULL CHECK (role IN (
                   'sender', 'recipient', 'introducer', 'observer')),

  -- For recipients. Which of these is authoritative depends on fee_mode:
  -- under 'deducted' the split is a percentage of what is left, under
  -- 'grossed_up' the amount is the fixed thing and the sender's total is
  -- derived from it.
  amount_minor   INTEGER,
  share_bps      INTEGER,

  invited_at     TEXT,
  accepted_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (transaction_id, party_id, role)
);

CREATE INDEX participations_transaction ON participations (transaction_id);
CREATE INDEX participations_party ON participations (party_id);

-- ---------------------------------------------------------------------------
-- Where the money goes
-- ---------------------------------------------------------------------------

-- Bank details or a wallet, decided by the transaction's outbound leg.
--
-- This table is where the money gets stolen if anywhere does: compromise a
-- recipient's mailbox, change an account number late in the day. Hence the
-- lifecycle — a destination is drafted, confirmed by its owner through a
-- second channel, then locked; and changing a locked one is a separate,
-- two-person act recorded below.
CREATE TABLE destinations (
  id               TEXT PRIMARY KEY,
  participation_id TEXT NOT NULL REFERENCES participations(id),
  kind             TEXT NOT NULL CHECK (kind IN ('bank', 'wallet')),

  account_name     TEXT,
  account_number   TEXT,
  sort_code        TEXT,
  iban             TEXT,
  bic              TEXT,
  bank_name        TEXT,
  bank_country     TEXT,

  chain            TEXT,
  address          TEXT,

  status           TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'confirmed', 'locked')),
  confirmed_at     TEXT,
  confirmed_via    TEXT,                       -- how the owner re-confirmed
  locked_at        TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX destinations_participation ON destinations (participation_id);

-- Changing a locked destination takes two of us, and the sender is told.
CREATE TABLE destination_changes (
  id             TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL REFERENCES destinations(id),
  before_json    TEXT NOT NULL,
  after_json     TEXT NOT NULL,
  reason         TEXT NOT NULL,
  requested_by   TEXT NOT NULL REFERENCES admins(id),
  approved_by    TEXT REFERENCES admins(id),
  approved_at    TEXT,
  sender_notified_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);

-- A crypto sender may send from more than one wallet, and each must be proved
-- by signature rather than typed.
CREATE TABLE sending_wallets (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  party_id       TEXT NOT NULL REFERENCES parties(id),
  chain          TEXT NOT NULL,
  address        TEXT NOT NULL,
  proved_at      TEXT,                         -- EIP-191 signature verified
  proof          TEXT,
  screened_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (transaction_id, chain, address)
);

-- ---------------------------------------------------------------------------
-- The dossier
-- ---------------------------------------------------------------------------

-- Who held the money, and when. Only one of the five types is genuinely
-- non-custodial; for the rest this is the record of every hand it passed
-- through, which is what lets the non-custody claim be made precisely about
-- the one product rather than loosely about the business.
CREATE TABLE custody_events (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  holder         TEXT NOT NULL CHECK (holder IN (
                   'client', 'thepaymaster_hsbc', 'otc_desk', 'none')),
  event          TEXT NOT NULL CHECK (event IN (
                   'received', 'converted', 'sent', 'fee_taken', 'returned')),
  amount_minor   INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  decimals       INTEGER NOT NULL,
  occurred_at    TEXT NOT NULL,
  evidence_id    TEXT,                         -- artefacts.id
  recorded_by    TEXT NOT NULL REFERENCES admins(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX custody_transaction ON custody_events (transaction_id, occurred_at);

-- Every document, hashed the moment it arrives.
--
-- The hash is taken on ingest and never recomputed from the stored copy: the
-- point is to be able to show years later that the file has not changed since
-- it was received. These hashes are the leaves of the transaction's Merkle
-- log, whose root eventually goes on-chain.
CREATE TABLE artefacts (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT REFERENCES transactions(id),
  party_id       TEXT REFERENCES parties(id),
  kind           TEXT NOT NULL,                -- mt103 | otc_confirmation |
                                               -- agency_agreement | kyc_report
                                               -- | bank_statement | call_recording
  label          TEXT,
  filename       TEXT,
  content_type   TEXT,
  bytes          INTEGER,
  r2_key         TEXT NOT NULL,
  sha256         TEXT NOT NULL,
  uploaded_by    TEXT,                         -- admin id or party id
  uploaded_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX artefacts_transaction ON artefacts (transaction_id, uploaded_at);

-- ---------------------------------------------------------------------------
-- The audit log
-- ---------------------------------------------------------------------------

-- Append-only. Nothing updates or deletes a row here, ever. Every state change
-- that matters is a human pressing a button with their name attached; this is
-- where that name is kept.
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL DEFAULT (datetime('now')),
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('admin', 'party', 'system')),
  actor_id     TEXT,
  action       TEXT NOT NULL,                  -- transaction.created, etc
  entity_kind  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  before_json  TEXT,
  after_json   TEXT,
  ip           TEXT,
  note         TEXT
);

CREATE INDEX audit_entity ON audit_log (entity_kind, entity_id, at);
CREATE INDEX audit_at ON audit_log (at);

-- Counter behind the human-readable reference. A table rather than a max()
-- over transactions so that a deleted or abandoned deal never lets a reference
-- be reissued.
CREATE TABLE ref_counter (
  year  INTEGER PRIMARY KEY,
  last  INTEGER NOT NULL DEFAULT 0
);
