-- Who makes the fiat payments. 'mandated': the client mandated account at HSBC
-- receives the sender's money and pays everyone. 'sender': the sender pays each
-- recipient, and our fee, from their own bank with our references; nothing
-- passes through an account we operate.
ALTER TABLE transactions ADD COLUMN fiat_payer TEXT NOT NULL DEFAULT 'mandated'
  CHECK (fiat_payer IN ('mandated', 'sender'));
