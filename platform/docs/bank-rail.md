# The bank rail

Fiat moves through the client mandated account at HSBC. The platform cannot
see that account for itself the way it sees a chain, so the record is built
from two things it controls: the references it puts on every payment, and the
statement it is given.

## References

| Payment | Reference |
|---|---|
| The sender's money arriving | `TPM-2026-0002` |
| Recipient *n* (roster order) | `TPM-2026-0002-01`, `-02`, … |
| Our fee to our own account | `TPM-2026-0002-FEE` |
| A penny to prove an account | `TPM PENNY K7X2QM` |

The reference plus the exact amount is the whole matching rule. Nothing is
recorded as paid on a partial match; a line that carries the reference with a
different amount is listed for a person.

## Proving a bank account: the penny test

Staff press **Send the penny** on the roster. The platform generates a
six-character code (no 0/O or 1/I), records it against the destination, shows
the reference to put on a 0.01 payment from the mandated account, and emails
the recipient to watch for it — the code itself is never in the email. The
recipient types the six characters from their statement; three misses and a
fresh penny is sent. A match sets `proved_at` with `proof_signature =
penny:<code>`, the same field a wallet signature would fill, so everything
downstream (journey, readiness, lock, certification) reads it unchanged.

## Payments out

**Download the payment file** on the Bank operations panel gives a CSV of the
outgoing payments not yet on the statement — beneficiary, sort code / account
or IBAN / BIC, amount, currency, reference — for the bank's bulk upload.

## The statement

Paste or upload the bank's CSV export. Columns are found by heading (date;
description / reference / narrative; either a signed amount column or paid-in
/ paid-out), dates in d/m/y, ISO or "10 Sep 2026". Each line is fingerprinted
(currency, date, reference, direction, amount) so importing the same export
twice adds nothing. Lines live in `bank_lines`, one pool for the whole account.

**Reconcile** walks what the transaction expects and, for each exact match,
calls `settlement.record` (holder `thepaymaster_hsbc`; `received`, `sent` +
`payout_legs`, or `fee_taken`) with the booked date and a note naming the
line. The line is stamped with the transaction and event. Pennies that left
the account are tied to the destination they tested. Matched lines are facts
in the dossier (`08c-bank-line`).

## What HSBC's API changes later

Only the import. Lines arriving from the bank go into the same table with the
same fingerprint; the references, the matching and the record stay as they are.

## The sender pays directly

`transactions.fiat_payer` (migration 0030): `mandated` (default) or `sender`.
Staff choose on the Bank operations panel of a fiat-to-fiat transaction; the
choice is fixed once any custody event exists.

In `sender` mode `holderFor()` is `client` throughout and nothing is expected
to arrive with us: `expected()` has no receipt row, the fee row carries our own
account from the `FEE_BANK_ACCOUNT` var, and `settlementChecks` drops "the
funds arrived" and asks instead that the fee has been paid to us. The sender's
page shows the payment file (`/d/:tx/payments.csv`, every recipient plus the
fee, with references) and a statement box (`POST /d/:tx/bank`) that imports
and reconciles in one step with the sender as actor. "Pay" is done only when
every leg *and* the fee are on the statement. A matched statement line counts
as the payment's evidence. The Counterparty Certification's basis line says
the funds were never held by ThePaymaster or in any account it operates.

Vars, set in `wrangler.toml [vars]` as `Name|sort code|account number|IBAN|BIC|bank`:
`FEE_BANK_ACCOUNT` (our account for the fee row) and `MANDATED_ACCOUNT` (what
a sender in mandated mode is told to pay into). Unset, the page says the
details will follow separately.
