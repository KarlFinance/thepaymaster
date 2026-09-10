-- ThePaymaster's signature on each seal.
--
-- An EIP-712 signature by the attestation key over the seal's fields (ref,
-- root, leaf count, sealed-at, algorithm), made when the seal is made — or,
-- for seals older than the key, the first time anyone asks for it. The
-- signing address is published in every certification and on the verifier.

ALTER TABLE dossier_seals ADD COLUMN attester    TEXT;
ALTER TABLE dossier_seals ADD COLUMN attestation TEXT;
