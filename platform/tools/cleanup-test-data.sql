-- Clear the test data from before ThePaymaster took real business (31 Oct 2026).
--
-- Every transaction, party, enquiry and document in production on that date was
-- a test. This empties the business tables and leaves the platform itself:
-- admins and their logins, settings, provider credentials, the house and fee
-- wallets, the badge contract record, and the website traffic log (only the
-- test visits from before 11:30 on 31 Oct go). The reference counter is reset,
-- so the first real transaction is TPM-2026-0001.
--
-- Children before parents, so it runs with foreign keys enforced.
-- Run by tools/cleanup-test-data.sh, which takes a backup first.

DELETE FROM payout_legs;
DELETE FROM room_access;
DELETE FROM room_invites;
DELETE FROM address_attestations;
DELETE FROM destination_changes;
DELETE FROM address_tests;
DELETE FROM badges;
DELETE FROM bank_lines;
DELETE FROM conversions;
DELETE FROM custody_events;
DELETE FROM dossier_seals;
DELETE FROM mandates;
DELETE FROM narratives;
DELETE FROM agreements;
DELETE FROM sending_wallets;
DELETE FROM wallet_screens;
DELETE FROM destinations;
DELETE FROM tokens;
DELETE FROM sessions;
DELETE FROM party_members;
DELETE FROM relationships;
DELETE FROM verifications;
DELETE FROM site_forms;
DELETE FROM enquiries;
DELETE FROM artefacts;
DELETE FROM participations;
DELETE FROM transactions;
DELETE FROM parties;
DELETE FROM ref_counter;
DELETE FROM traffic_hits WHERE at < '2026-10-31 11:30:00';

INSERT INTO audit_log (actor_kind, actor_id, action, entity_kind, entity_id, note)
VALUES ('admin', NULL, 'platform.test_data_cleared', 'platform', 'production',
        'All test transactions, parties, enquiries, documents and their records cleared before taking real business. Backup taken first.');
