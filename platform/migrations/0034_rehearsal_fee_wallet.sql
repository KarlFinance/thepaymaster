-- The rehearsal fee wallet on Sepolia, so flow.sh and hand rehearsals can pick
-- a registered wallet the way a real transaction must.
INSERT INTO house_wallets (id, label, role, rail, address) VALUES
  ('hw_sepolia_fee', 'Rehearsal fee wallet — USDT on Sepolia (test network)', 'fee', 'eth:11155111:usdt', '0x048B3C145F05Fef0e2f837A5207bd912EdFf7e5e');
